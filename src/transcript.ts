// Claude Code 트랜스크립트(jsonl) 파서.
// 한 턴이 블록 단위로 여러 줄에 쪼개져 있음:
//   user(지시) → assistant(text|tool_use) → user(tool_result) → assistant ... → assistant(stop_reason: end_turn)
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
  endedAt?: string;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

// 사람이(또는 send로) 친 지시만 턴 시작으로 봄. tool_result, 메타 메시지는 제외.
function promptText(rec: any): string | undefined {
  if (rec.type !== 'user' || rec.isMeta || rec.isSidechain) return undefined;
  const c = rec.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c) || c.some((b: any) => b?.type === 'tool_result')) return undefined;
  const text = c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n');
  return text || undefined;
}

export function readTurns(file: string): Turn[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

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

    const prompt = promptText(rec);
    if (prompt !== undefined) {
      cur = { prompt, promptAt: rec.timestamp, texts: [], tools: [], complete: false };
      turns.push(cur);
      continue;
    }
    if (rec.type !== 'assistant' || rec.isSidechain || !cur) continue;

    for (const b of rec.message?.content ?? []) {
      if (b?.type === 'text' && b.text?.trim()) cur.texts.push(b.text.trim());
      else if (b?.type === 'tool_use') cur.tools.push({ name: b.name, input: clip(JSON.stringify(b.input ?? {}), 300) });
    }
    // end_turn 뒤에 이어지는 게 있으면 (중단 후 재개 등) 다시 미완료로
    cur.complete = rec.message?.stop_reason === 'end_turn';
    cur.endedAt = rec.timestamp;
  }
  return turns;
}

export const lastTurn = (file: string): Turn | undefined => readTurns(file).at(-1);
