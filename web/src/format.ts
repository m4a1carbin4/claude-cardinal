import type { Session } from './types';

export function ago(iso?: string | null): string {
  if (!iso) return '-';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  if (s < 86400) return `${Math.round(s / 3600)}시간 전`;
  return `${Math.round(s / 86400)}일 전`;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

// 14:05:09.123 (오늘이 아니면 앞에 월/일)
export function clock(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  return d.toDateString() === new Date().toDateString() ? t : `${d.getMonth() + 1}/${d.getDate()} ${t}`;
}

// send 로 붙여넣은 지시는 Claude Code 가 <pasted_content id="…"> 로 감싸서 기록함. 화면엔 내용만
export const unwrapPasted = (s: string) => s.replace(/<\/?pasted_content[^>]*>/g, '').trim();

export const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

// 세션 상태를 사람이 읽는 말로. Esc 중단은 DB 에선 idle + last_event Interrupted
export function stateLabel(s: Session): { label: string; tone: 'ok' | 'busy' | 'warn' | 'muted' | 'info' } {
  if (s.deleted_at) return { label: '삭제됨', tone: 'muted' };
  if (!s.alive || s.state === 'ended') return { label: '종료', tone: 'muted' };
  switch (s.state) {
    case 'idle':
      return s.last_event === 'Interrupted' ? { label: '사람이 중단함', tone: 'info' } : { label: '대기', tone: 'ok' };
    case 'busy':
      return { label: s.tool ? `작업 중 · ${s.tool}` : '작업 중', tone: 'busy' };
    case 'waiting':
      return { label: '승인 대기', tone: 'warn' };
    case 'starting':
      return { label: '준비 중', tone: 'info' };
    default:
      return { label: s.state, tone: 'muted' };
  }
}
