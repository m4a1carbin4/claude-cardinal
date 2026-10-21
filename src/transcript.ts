// Claude Code 트랜스크립트(jsonl) 파서.
// 한 턴이 블록 단위로 여러 줄에 쪼개져 있음:
//   user(지시) → assistant(text|tool_use) → user(tool_result) → assistant ... → assistant(stop_reason: end_turn)
//
// user 줄이라고 다 사람 입력이 아님. 실측으로 확인한 것들:
//   사람/send 입력          origin.kind = "human"   → 턴 시작
//   백그라운드 작업 완료 알림  origin.kind = "task-notification" (<task-notification>…) → claude가 스스로 시작한 턴. 사람 턴 아님
//   Esc 중단                "[Request interrupted by user]" / "… for tool use]" (origin 없음) → 진행 중이던 턴이 중단으로 끝남
//   /clear, /compact 명령 줄, 압축 요약, 명령 출력 (origin 없음) → 무시
import fs from 'node:fs';

export interface ToolCall {
  name: string;
  input: string; // 요약 (앞부분만)
}

export interface Turn {
  prompt: string;
  promptAt?: string;
  texts: string[]; // 이 턴에서 assistant가 쓴 텍스트 블록 전부 (중간 보고 포함)
  tools: ToolCall[];
  complete: boolean; // 마지막 assistant 줄이 end_turn 이면 true
  interrupted: boolean; // 사람이 Esc 로 중단
  endedAt?: string;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

const INTERRUPT_RE = /^\[Request interrupted by user/;
// origin 필드가 없던 예전 버전 트랜스크립트용 판별
const NON_HUMAN_RE = /^(<command-name>|<command-message>|<local-command-|<task-notification>|This session is being continued|Caveat: )/;

type UserKind = 'human' | 'interrupt' | 'agent' | 'ignore';

function userText(rec: any): string | undefined {
  const c = rec.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c) || c.some((b: any) => b?.type === 'tool_result')) return undefined;
  const text = c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n');
  return text || undefined;
}

// hasOrigin: 이 트랜스크립트가 origin 필드를 쓰는 버전인지
function classify(rec: any, hasOrigin: boolean): { kind: UserKind; text: string } | undefined {
  if (rec.type !== 'user' || rec.isMeta || rec.isSidechain) return undefined;
  const text = userText(rec);
  if (text === undefined) return undefined; // tool_result 등
  const t = text.trim();
  if (INTERRUPT_RE.test(t)) return { kind: 'interrupt', text };
  const origin = rec.origin?.kind;
  if (origin === 'task-notification' || t.startsWith('<task-notification>')) return { kind: 'agent', text };
  if (hasOrigin) return { kind: origin === 'human' ? 'human' : 'ignore', text };
  return { kind: NON_HUMAN_RE.test(t) ? 'ignore' : 'human', text };
}

export function readTurns(file: string): Turn[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const hasOrigin = raw.includes('"origin":{"kind"');

  const turns: Turn[] = [];
  let cur: Turn | undefined;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // 쓰는 중인 마지막 줄 같은 거
    }

    const u = classify(rec, hasOrigin);
    if (u) {
      if (u.kind === 'human') {
        cur = { prompt: u.text, promptAt: rec.timestamp, texts: [], tools: [], complete: false, interrupted: false };
        turns.push(cur);
      } else if (u.kind === 'interrupt') {
        // 진행 중이던 사람 턴이 중단으로 끝남. 이후 assistant 줄은 이 턴 것이 아님
        if (cur) {
          cur.interrupted = true;
          cur.complete = false;
          cur.endedAt = rec.timestamp;
        }
        cur = undefined;
      } else if (u.kind === 'agent') {
        // claude가 스스로 시작한 턴: 사람 턴으로 세지 않고, 그 답이 앞 사람 턴에 섞이지도 않게 끊음
        cur = undefined;
      }
      // ignore: 명령 줄/압축 요약은 턴을 끊지 않음 (턴 도중 자동 압축 뒤 이어지는 답은 같은 턴)
      continue;
    }
    if (rec.type !== 'assistant' || rec.isSidechain || !cur) continue;

    for (const b of rec.message?.content ?? []) {
      if (b?.type === 'text' && b.text?.trim()) cur.texts.push(b.text.trim());
      else if (b?.type === 'tool_use') cur.tools.push({ name: b.name, input: clip(JSON.stringify(b.input ?? {}), 300) });
    }
    // end_turn 뒤에 이어지는 게 있으면 (재개 등) 다시 미완료로
    cur.complete = rec.message?.stop_reason === 'end_turn';
    cur.endedAt = rec.timestamp;
  }
  return turns;
}

export const lastTurn = (file: string): Turn | undefined => readTurns(file).at(-1);

const TAIL_BYTES = 512 * 1024;

// 트랜스크립트 끝에서부터 보고, 마지막 사람 입력보다 뒤에 Esc 중단이 있으면 그 시각.
// 훅으로는 중단을 알 수 없어서 (Stop 이 안 옴) 상태 보정용으로 씀. 큰 파일 대비 뒤쪽만 읽음
export function interruptedAt(file: string): string | undefined {
  let buf: Buffer;
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
  } catch {
    return undefined;
  }
  const raw = buf.toString('utf8');
  const hasOrigin = raw.includes('"origin":{"kind"');
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec: any;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const u = classify(rec, hasOrigin);
    if (!u || u.kind === 'ignore') continue;
    return u.kind === 'interrupt' ? rec.timestamp : undefined;
  }
  return undefined;
}
