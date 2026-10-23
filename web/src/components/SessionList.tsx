import { basename, stateLabel } from '../format';
import type { Session } from '../types';

export function SessionList({
  sessions,
  selected,
  onSelect,
  showDeleted,
  onToggleDeleted,
}: {
  sessions: Session[];
  selected: string | null;
  onSelect: (name: string) => void;
  showDeleted: boolean;
  onToggleDeleted: (v: boolean) => void;
}) {
  const list = showDeleted ? sessions : sessions.filter((s) => !s.deleted_at);
  return (
    <div className="session-list">
      <div className="list-head">
        <span>세션 {list.length}</span>
        <label className="check small">
          <input type="checkbox" checked={showDeleted} onChange={(e) => onToggleDeleted(e.target.checked)} /> 삭제된 것도
        </label>
      </div>
      {list.length === 0 && <div className="empty small">세션 없음. 위의 “새 세션”으로 만들어 보세요.</div>}
      <ul>
        {list.map((s) => {
          const st = stateLabel(s);
          // 같은 이름이 삭제된 기록으로 여러 개 있을 수 있어서 키는 고유 키로
          const isSel = !s.deleted_at && s.name === selected;
          return (
            <li key={s.id}>
              <button
                className={`session-item ${isSel ? 'sel' : ''} ${s.deleted_at ? 'deleted' : ''}`}
                onClick={() => !s.deleted_at && onSelect(s.name)}
                disabled={!!s.deleted_at}
                title={s.cwd}
              >
                <span className={`dot ${st.tone}`} />
                <span className="si-main">
                  <span className="si-name">
                    {s.name}
                    <span className={`role ${s.role}`}>{s.role}</span>
                  </span>
                  <span className="si-sub">
                    {st.label} · {basename(s.cwd)}
                    {s.parent_name ? ` · ↳ ${s.parent_name}` : ''}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
