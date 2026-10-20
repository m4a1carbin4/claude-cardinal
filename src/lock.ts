// 세션별 파일 락. 같은 세션에 send 가 동시에 들어오면 붙여넣기~Enter 가 섞여서 한 입력으로 합쳐지는 걸 막음.
// 프로세스가 달라도 (CLI 여러 개, 서버, 마스터 세션) 같은 파일을 보니까 다 같이 줄 섬.
import fs from 'node:fs';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 락을 이보다 오래 잡고 있으면 죽은 걸로 봄. send 가 락 안에서 idle 을 최대 10분 기다리니까 그보다 넉넉히.
// pid 가 재사용돼서 엉뚱한 프로세스가 살아있는 걸로 보이는 경우에도 결국 풀리게 하려는 것.
const MAX_HOLD_MS = 30 * 60_000;

interface Holder {
  raw: string;
  pid: number;
  at: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM'; // 살아있는데 권한만 없는 경우
  }
}

// 락 파일 내용: "<pid> <잡은 시각 ms>"
function readHolder(file: string): Holder | undefined {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const [pid, at] = raw.trim().split(/\s+/).map(Number);
    return pid ? { raw, pid, at: at || 0 } : undefined;
  } catch {
    return undefined;
  }
}

// 내용을 tmp 에 먼저 쓰고 link 로 락 파일을 만듦.
// link 는 대상이 있으면 실패해서 원자적이고, 락 파일이 생긴 순간 이미 내용이 들어 있음 (빈 락 파일을 남이 볼 일 없음)
function tryAcquire(file: string): string | undefined {
  const content = `${process.pid} ${Date.now()}`;
  const tmp = `${file}.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content);
  try {
    fs.linkSync(tmp, file);
    return content;
  } catch (e: any) {
    if (e?.code !== 'EEXIST') throw e;
    return undefined;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// 죽은 락 치우기. 지우기 직전에 내용을 다시 읽어서, 그 사이 남이 새로 잡은 락은 안 지움
function clearIfStale(file: string): boolean {
  const h = readHolder(file);
  if (!h) return false;
  const stale = !pidAlive(h.pid) || (h.at > 0 && Date.now() - h.at > MAX_HOLD_MS);
  if (!stale) return false;
  if (readHolder(file)?.raw !== h.raw) return false;
  fs.rmSync(file, { force: true });
  return true;
}

export async function withLock<T>(file: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let mine: string | undefined;
  for (;;) {
    mine = tryAcquire(file);
    if (mine) break;
    if (clearIfStale(file)) continue;
    if (Date.now() > deadline) throw new Error(`락 대기 시간 초과 (잡고 있는 pid ${readHolder(file)?.pid ?? '?'})`);
    await sleep(50);
  }
  try {
    return await fn();
  } finally {
    // 내가 잡은 락일 때만 지움 (오래 걸려서 남이 죽은 걸로 보고 치운 뒤 새로 잡았을 수도 있으니까)
    if (readHolder(file)?.raw === mine) fs.rmSync(file, { force: true });
  }
}
