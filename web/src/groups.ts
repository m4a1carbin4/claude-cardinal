import { useCallback, useState } from 'react';

// 세션 그룹·숨김. 이 브라우저에만 저장 (서버로 안 감). 세션은 이름으로 묶음 (살아 있는 세션 이름은 겹치지 않음)
export interface Group {
  id: string;
  name: string;
  collapsed: boolean;
}

export interface GroupState {
  groups: Group[];
  of: Record<string, string>; // 세션 이름 → 그룹 id
  hidden: string[]; // 숨긴 세션 이름
  ungroupedCollapsed: boolean;
}

const KEY = 'cardinal.groups';
const EMPTY: GroupState = { groups: [], of: {}, hidden: [], ungroupedCollapsed: false };

function load(): GroupState {
  try {
    return { ...EMPTY, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return EMPTY;
  }
}

export function useGroups() {
  const [state, setState] = useState<GroupState>(load);

  const change = useCallback((fn: (s: GroupState) => GroupState) => {
    setState((prev) => {
      const next = fn(prev);
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // 저장 못 해도 이번 화면에선 그대로 씀
      }
      return next;
    });
  }, []);

  return {
    state,
    addGroup: (name: string) =>
      change((s) => ({ ...s, groups: [...s.groups, { id: Date.now().toString(36), name, collapsed: false }] })),
    renameGroup: (id: string, name: string) => change((s) => ({ ...s, groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)) })),
    // 그룹을 지우면 안의 세션은 “그룹 없음”으로 돌아감
    removeGroup: (id: string) =>
      change((s) => ({
        ...s,
        groups: s.groups.filter((g) => g.id !== id),
        of: Object.fromEntries(Object.entries(s.of).filter(([, g]) => g !== id)),
      })),
    moveGroup: (id: string, dir: -1 | 1) =>
      change((s) => {
        const i = s.groups.findIndex((g) => g.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= s.groups.length) return s;
        const groups = [...s.groups];
        [groups[i], groups[j]] = [groups[j], groups[i]];
        return { ...s, groups };
      }),
    toggleGroup: (id: string | null) =>
      change((s) =>
        id === null
          ? { ...s, ungroupedCollapsed: !s.ungroupedCollapsed }
          : { ...s, groups: s.groups.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)) },
      ),
    setAllCollapsed: (collapsed: boolean) =>
      change((s) => ({ ...s, ungroupedCollapsed: collapsed, groups: s.groups.map((g) => ({ ...g, collapsed })) })),
    assign: (session: string, group: string | null) =>
      change((s) => {
        const of = { ...s.of };
        if (group) of[session] = group;
        else delete of[session];
        return { ...s, of };
      }),
    setHidden: (session: string, hidden: boolean) =>
      change((s) => ({ ...s, hidden: hidden ? [...new Set([...s.hidden, session])] : s.hidden.filter((n) => n !== session) })),
  };
}
