// 세션별 파일 락. 같은 세션에 send 가 동시에 들어오면 붙여넣기~Enter 가 섞여서 한 입력으로 합쳐지는 걸 막음.
// 프로세스가 달라도 (CLI 여러 개, 서버, 마스터 세션) 같은 파일을 보니까 다 같이 줄 섬.
import fs from 'node:fs';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM'; // 살아있는데 권한만 없는 경우
  }
}

function holder(file: string): number | undefined {
  try {
    return Number(fs.readFileSync(file, 'utf8')) || undefined;
  } catch {
    return undefined;
  }
}

// pid 를 먼저 tmp 에 써두고 link 로 락 파일을 만듦.
// link 는 대상이 있으면 실패해서 원자적이고, 락 파일이 생긴 순간 이미 pid 가 들어 있음 (빈 파일을 남이 볼 일 없음)
function tryAcquire(file: string): boolean {
  const tmp = `${file}.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, String(process.pid));
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e: any) {
    if (e?.code !== 'EEXIST') throw e;
    return false;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export async function withLock<T>(file: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tryAcquire(file)) break;
    const pid = holder(file);
    // 잡고 있던 프로세스가 죽었으면 (CLI 강제 종료 등) 치우고 다시
    if (pid && !pidAlive(pid)) {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`세션 락 대기 시간 초과 (잡고 있는 pid ${pid ?? '?'})`);
    await sleep(50);
  }
  try {
    return await fn();
  } finally {
    if (holder(file) === process.pid) fs.rmSync(file, { force: true });
  }
}
