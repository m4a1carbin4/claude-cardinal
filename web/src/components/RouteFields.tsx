import type { RouteInput } from '../types';

export const emptyRoute = (): RouteInput => ({ platform: '*', channel: null, trigger: null, match: 'prefix', auto_reply: false });

// 라우트 하나 입력 (채널명 + 트리거 + 매칭 방식 + 자동 답장)
export function RouteFields({ value, onChange }: { value: RouteInput; onChange: (r: RouteInput) => void }) {
  const set = (patch: Partial<RouteInput>) => onChange({ ...value, ...patch });
  return (
    <div className="route-fields">
      <label>
        플랫폼
        <select value={value.platform} onChange={(e) => set({ platform: e.target.value as RouteInput['platform'] })}>
          <option value="*">모든 채널</option>
          <option value="discord">discord</option>
          <option value="local">local</option>
        </select>
      </label>
      <label>
        채널 (이름/ID)
        <input value={value.channel ?? ''} placeholder="비우면 아무 채널" onChange={(e) => set({ channel: e.target.value || null })} />
      </label>
      <label>
        매칭
        <select value={value.match} onChange={(e) => set({ match: e.target.value as RouteInput['match'] })}>
          <option value="prefix">prefix (트리거로 시작)</option>
          <option value="contains">contains (포함)</option>
          <option value="regex">regex</option>
          <option value="mention">@봇 멘션</option>
        </select>
      </label>
      <label>
        트리거
        <input
          value={value.trigger ?? ''}
          placeholder={value.match === 'mention' ? '멘션은 트리거 안 씀' : '예: !ask (비우면 모든 메시지)'}
          disabled={value.match === 'mention'}
          onChange={(e) => set({ trigger: e.target.value || null })}
        />
      </label>
      <label className="check">
        <input type="checkbox" checked={value.auto_reply} onChange={(e) => set({ auto_reply: e.target.checked })} />
        턴 끝나면 자동 답장
      </label>
    </div>
  );
}
