// 관리자 답(마크다운) → 말풍선 대사 덩어리. [emo:NN] 은 그 문단부터 표정 번호
export interface Line {
  text: string;
  emotion: number | null;
}

const EMO = /\[emo:(\d{1,2})\]/g;

function plain(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 이미지
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 링크 → 글자만
    .replace(/^\s{0,3}#{1,6}\s+/, '') // 제목
    .replace(/^\s*>\s?/, '') // 인용
    .replace(/^\s*[-*+]\s+/, '· ') // 목록
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

// 너무 긴 문단은 문장 끝에서 잘라 max 글자 안쪽으로
function pack(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = '';
  for (const s of text.split(/(?<=[.!?。…~])\s+|\n/)) {
    if (cur && cur.length + s.length + 1 > max) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur} ${s}` : s;
    while (cur.length > max) {
      out.push(cur.slice(0, max));
      cur = cur.slice(max);
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function toLines(md: string, emotion: number | null = null, max = 160): Line[] {
  const lines: Line[] = [];
  const body = md.replace(/```[\s\S]*?(```|$)/g, '\n\n(코드는 대화 탭에서 봐 주세요)\n\n');
  for (const para of body.split(/\n\s*\n/)) {
    let text = para.replace(EMO, (_, n: string) => {
      emotion = Number(n);
      return '';
    });
    text = text
      .split('\n')
      .filter((l) => !/^\s*\|/.test(l) && !/^\s*([-*_])\1{2,}\s*$/.test(l)) // 표, 가로줄
      .map(plain)
      .filter(Boolean)
      .join('\n');
    for (const t of pack(text, max)) lines.push({ text: t, emotion });
  }
  return lines;
}

// 이전 답이 남긴 마지막 표정 (다음 메시지로 이어줌)
export const lastEmotion = (lines: Line[], fallback: number | null) => (lines.length ? lines[lines.length - 1].emotion : fallback);
