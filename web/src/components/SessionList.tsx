import { type DragEvent, type FormEvent, useState } from 'react';
import { basename, stateLabel } from '../format';
import { type Group, useGroups } from '../groups';
import type { Session } from '../types';

const DRAG_TYPE = 'application/x-cardinal-session';

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
  const g = useGroups();
  const [showHidden, setShowHidden] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null); // ⋯ 메뉴를 연 세션 키
  const [editing, setEditing] = useState<string | null>(null); // 이름 고치는 그룹 id, 'new' 면 새 그룹
  const [dropOn, setDropOn] = useState<string | null>(null);

  const hidden = new Set(g.state.hidden);
  const alive = showDeleted ? sessions : sessions.filter((s) => !s.deleted_at);
  // 고른 세션은 숨겼어도 보여 줌 (안 그러면 지금 보는 게 목록에서 사라짐)
  const list = showHidden ? alive : alive.filter((s) => !hidden.has(s.name) || s.name === selected);
  const hiddenCount = alive.filter((s) => hidden.has(s.name)).length;
  const known = new Set(g.state.groups.map((x) => x.id));
  const groupOf = (s: Session) => (known.has(g.state.of[s.name]) ? g.state.of[s.name] : null);
  const grouped = g.state.groups.length > 0;

  const drop = (group: string | null) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      setDropOn(group ?? '');
    },
    onDragLeave: () => setDropOn(null),
    onDrop: (e: DragEvent) => {
      const name = e.dataTransfer.getData(DRAG_TYPE);
      setDropOn(null);
      if (name) g.assign(name, group);
    },
  });

  const item = (s: Session) => {
    const st = stateLabel(s);
    // 같은 이름이 삭제된 기록으로 여러 개 있을 수 있어서 키는 고유 키로
    const isSel = !s.deleted_at && s.name === selected;
    const isHidden = hidden.has(s.name);
    return (
      <li
        key={s.id}
        className="si-row"
        draggable={!s.deleted_at}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, s.name);
          e.dataTransfer.effectAllowed = 'move';
        }}
      >
        <button
          className={`session-item ${isSel ? 'sel' : ''} ${s.deleted_at ? 'deleted' : ''} ${isHidden ? 'hidden' : ''}`}
          onClick={() => !s.deleted_at && onSelect(s.name)}
          disabled={!!s.deleted_at}
          title={s.cwd}
        >
          <span className={`dot ${st.tone}`} />
          <span className="si-main">
            <span className="si-name">
              {s.name}
              <span className={`role ${s.role}`}>{s.role}</span>
              {s.admin && <span className="role admin">admin</span>}
              {s.backend === 'sdk' && <span className="role sdk">SDK</span>}
              {isHidden && <span className="role">숨김</span>}
            </span>
            <span className="si-sub">
              {st.label} · {basename(s.cwd)}
              {s.parent_name ? ` · ↳ ${s.parent_name}` : ''}
            </span>
          </span>
        </button>
        {!s.deleted_at && (
          <button
            className={`si-more ghost small ${menuFor === s.id ? 'on' : ''}`}
            onClick={() => setMenuFor(menuFor === s.id ? null : s.id)}
            title="그룹 옮기기 · 숨기기"
          >
            ⋯
          </button>
        )}
        {menuFor === s.id && (
          <div className="si-menu">
            <label>
              그룹
              <select
                value={groupOf(s) ?? ''}
                onChange={(e) => {
                  g.assign(s.name, e.target.value || null);
                  setMenuFor(null);
                }}
              >
                <option value="">그룹 없음</option>
                {g.state.groups.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="ghost small"
              onClick={() => {
                g.setHidden(s.name, !isHidden);
                setMenuFor(null);
              }}
            >
              {isHidden ? '다시 보이기' : '목록에서 숨기기'}
            </button>
          </div>
        )}
      </li>
    );
  };

  const section = (group: Group | null, items: Session[]) => {
    const id = group?.id ?? null;
    const collapsed = group ? group.collapsed : g.state.ungroupedCollapsed;
    const hasSel = collapsed && items.some((s) => !s.deleted_at && s.name === selected);
    // 접어 둬도 답·승인을 기다리는 세션(warn)이나 일하는 세션(busy)이 있으면 점으로 알려 줌
    const tones = items.map((s) => stateLabel(s).tone);
    const waiting = tones.filter((t) => t === 'warn').length;
    const busy = tones.filter((t) => t === 'busy').length;
    return (
      <section key={id ?? '-'} className={`sg ${dropOn === (id ?? '') ? 'drop' : ''}`} {...drop(id)}>
        {editing === id && group ? (
          <GroupNameForm
            initial={group.name}
            onDone={(name) => {
              if (name) g.renameGroup(group.id, name);
              setEditing(null);
            }}
          />
        ) : (
          <div className="sg-head">
            <button className="sg-toggle" onClick={() => g.toggleGroup(id)} aria-expanded={!collapsed}>
              <span className="sg-caret">{collapsed ? '▸' : '▾'}</span>
              <span className="sg-name">{group ? group.name : '그룹 없음'}</span>
              <span className="sg-count">{items.length}</span>
              {collapsed && waiting > 0 && <span className="dot warn" title={`기다리는 중 ${waiting}`} />}
              {collapsed && busy > 0 && <span className="dot busy" title={`작업 중 ${busy}`} />}
              {hasSel && <span className="sg-sel" title="지금 보는 세션이 이 안에 있음" />}
            </button>
            {group && (
              <span className="sg-actions">
                <button className="ghost small" onClick={() => g.moveGroup(group.id, -1)} title="위로">
                  ↑
                </button>
                <button className="ghost small" onClick={() => g.moveGroup(group.id, 1)} title="아래로">
                  ↓
                </button>
                <button className="ghost small" onClick={() => setEditing(group.id)} title="이름 바꾸기">
                  ✎
                </button>
                <button className="ghost small danger" onClick={() => g.removeGroup(group.id)} title="그룹 지우기 (세션은 그룹 없음으로)">
                  ✕
                </button>
              </span>
            )}
          </div>
        )}
        {!collapsed &&
          (items.length ? <ul>{items.map(item)}</ul> : <div className="sg-empty small muted">세션을 여기로 끌어 놓기</div>)}
      </section>
    );
  };

  return (
    <div className="session-list">
      <div className="list-head">
        <span>세션 {list.length}</span>
        <span className="row">
          <label className="check small">
            <input type="checkbox" checked={showDeleted} onChange={(e) => onToggleDeleted(e.target.checked)} /> 삭제된 것도
          </label>
          {(hiddenCount > 0 || showHidden) && (
            <label className="check small" title="목록에서 숨긴 세션도 보기">
              <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> 숨긴 것 {hiddenCount}
            </label>
          )}
        </span>
      </div>
      <div className="sg-tools">
        <button className="ghost small" onClick={() => setEditing('new')} title="세션 그룹 만들기 (이 브라우저에만 저장)">
          + 그룹
        </button>
        {grouped && (
          <>
            <button className="ghost small" onClick={() => g.setAllCollapsed(true)} title="모두 접기">
              모두 접기
            </button>
            <button className="ghost small" onClick={() => g.setAllCollapsed(false)} title="모두 펼치기">
              모두 펼치기
            </button>
          </>
        )}
      </div>
      {editing === 'new' && (
        <GroupNameForm
          initial=""
          onDone={(name) => {
            if (name) g.addGroup(name);
            setEditing(null);
          }}
        />
      )}
      {list.length === 0 && <div className="empty small">세션 없음. 위의 “새 세션”으로 만들어 보세요.</div>}
      <div className="sl-body">
        {grouped ? (
          <>
            {g.state.groups.map((x) => section(x, list.filter((s) => groupOf(s) === x.id)))}
            {section(
              null,
              list.filter((s) => groupOf(s) === null),
            )}
          </>
        ) : (
          list.length > 0 && <ul>{list.map(item)}</ul>
        )}
      </div>
    </div>
  );
}

function GroupNameForm({ initial, onDone }: { initial: string; onDone: (name: string) => void }) {
  const [name, setName] = useState(initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onDone(name.trim());
  };
  return (
    <form className="sg-form" onSubmit={submit}>
      <input
        autoFocus
        value={name}
        placeholder="그룹 이름"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onDone('')}
      />
      <button className="small primary" type="submit" disabled={!name.trim()}>
        {initial ? '바꾸기' : '만들기'}
      </button>
      <button className="small ghost" type="button" onClick={() => onDone('')}>
        취소
      </button>
    </form>
  );
}
