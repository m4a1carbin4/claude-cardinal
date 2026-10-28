import type { Effort, McpServerConfig, PermissionMode, SdkOptions } from '../types';

// SDK 세션 옵션 입력 (새 세션 만들 때 / 다시 시작할 때 같이 씀).
// 목록·여러 줄 값은 글자로 들고 있다가 보낼 때 바꿈 (toOptions)
export interface SdkForm {
  permission_mode: PermissionMode;
  model: string;
  fallback_model: string;
  effort: Effort | '';
  append_prompt: string;
  mcp: string; // JSON {"이름": {...}}
  strict_mcp_config: boolean;
  allowed_tools: string;
  disallowed_tools: string;
  add_dirs: string; // 한 줄에 하나
  env: string; // KEY=VALUE 한 줄에 하나
  partial: boolean;
  max_turns: string;
  max_budget_usd: string;
  question_timeout_s: string;
  resume_on_start: boolean;
  chrome: '' | 'on' | 'off';
}

export const PERMISSION_MODES: { id: PermissionMode; label: string }[] = [
  { id: 'auto', label: 'auto — 알아서 판단 (기본)' },
  { id: 'default', label: 'default — 위험한 건 물어봄' },
  { id: 'acceptEdits', label: 'acceptEdits — 파일 수정은 허용' },
  { id: 'plan', label: 'plan — 계획만, 실행 안 함' },
  { id: 'dontAsk', label: 'dontAsk — 허용 목록 밖은 거부' },
  { id: 'bypassPermissions', label: 'bypassPermissions — 다 허용 (주의)' },
];

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function formFromOptions(o?: Partial<SdkOptions> | null): SdkForm {
  const mcp = o?.mcp_servers ?? {};
  return {
    permission_mode: o?.permission_mode ?? 'auto',
    model: o?.model ?? '',
    fallback_model: o?.fallback_model ?? '',
    effort: o?.effort ?? '',
    append_prompt: o?.append_prompt ?? '',
    mcp: Object.keys(mcp).length ? JSON.stringify(mcp, null, 2) : '',
    strict_mcp_config: o?.strict_mcp_config ?? false,
    allowed_tools: (o?.allowed_tools ?? []).join(' '),
    disallowed_tools: (o?.disallowed_tools ?? []).join(' '),
    add_dirs: (o?.add_dirs ?? []).join('\n'),
    env: Object.entries(o?.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    partial: o?.partial ?? false,
    max_turns: o?.max_turns != null ? String(o.max_turns) : '',
    max_budget_usd: o?.max_budget_usd != null ? String(o.max_budget_usd) : '',
    question_timeout_s: o?.question_timeout_s != null ? String(o.question_timeout_s) : '',
    resume_on_start: o?.resume_on_start ?? false,
    chrome: o?.chrome == null ? '' : o.chrome ? 'on' : 'off',
  };
}

const words = (s: string) => s.split(/[\s,]+/).filter(Boolean);
const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
const numOrNull = (s: string) => (s.trim() ? Number(s) : null);

// 폼 → 서버로 보낼 옵션. 잘못된 값이면 error
export function toOptions(f: SdkForm): { options?: Partial<SdkOptions>; error?: string } {
  let mcp: Record<string, McpServerConfig> = {};
  if (f.mcp.trim()) {
    try {
      mcp = JSON.parse(f.mcp);
    } catch (e) {
      return { error: `MCP 서버 JSON 오류: ${(e as Error).message}` };
    }
    if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) return { error: 'MCP 서버는 {"이름": {...}} 모양의 JSON 객체' };
  }
  const env: Record<string, string> = {};
  for (const l of lines(f.env)) {
    const i = l.indexOf('=');
    if (i <= 0) return { error: `환경변수는 KEY=VALUE: ${l}` };
    env[l.slice(0, i).trim()] = l.slice(i + 1);
  }
  const dirs = lines(f.add_dirs);
  const bad = dirs.find((d) => !d.startsWith('/'));
  if (bad) return { error: `추가 폴더는 절대 경로: ${bad}` };
  for (const [k, v] of [
    ['최대 턴', f.max_turns],
    ['최대 비용', f.max_budget_usd],
    ['질문 답 제한 시간', f.question_timeout_s],
  ]) {
    if (v.trim() && !(Number(v) > 0)) return { error: `${k}는 0보다 큰 숫자` };
  }
  return {
    options: {
      permission_mode: f.permission_mode,
      model: f.model.trim() || null,
      fallback_model: f.fallback_model.trim() || null,
      effort: f.effort || null,
      append_prompt: f.append_prompt.trim() || null,
      mcp_servers: mcp,
      strict_mcp_config: f.strict_mcp_config,
      allowed_tools: words(f.allowed_tools),
      disallowed_tools: words(f.disallowed_tools),
      add_dirs: dirs,
      env,
      partial: f.partial,
      max_turns: numOrNull(f.max_turns),
      max_budget_usd: numOrNull(f.max_budget_usd),
      question_timeout_s: numOrNull(f.question_timeout_s),
      resume_on_start: f.resume_on_start,
      chrome: f.chrome === '' ? null : f.chrome === 'on',
    },
  };
}

const MCP_PLACEHOLDER = `{
  "tts": {"type": "stdio", "command": "/usr/bin/python3", "args": ["tts_mcp.py"]},
  "web": {"type": "http", "url": "https://…", "headers": {"Authorization": "Bearer …"}}
}`;

// redacted: 목록에서 받은 값이라 env/헤더가 *** 로 가려져 있음 (그대로 두면 서버가 원래 값을 씀)
export function SdkOptionsFields({ value, onChange, redacted = false }: { value: SdkForm; onChange: (f: SdkForm) => void; redacted?: boolean }) {
  const set = (patch: Partial<SdkForm>) => onChange({ ...value, ...patch });
  return (
    <div className="sdk-fields">
      <div className="grid2">
        <label>
          권한 모드
          <select value={value.permission_mode} onChange={(e) => set({ permission_mode: e.target.value as PermissionMode })}>
            {PERMISSION_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          모델
          <input value={value.model} onChange={(e) => set({ model: e.target.value })} placeholder="비우면 기본 (예: sonnet, opus, haiku)" />
        </label>
      </div>
      <label title="브라우저 조작 MCP (claude-in-chrome). 터미널 claude 는 /chrome 의 '기본으로 켜기' 를 따르지만 SDK 는 따로 켜야 해서, 기본은 그 값을 대신 읽어 맞춤">
        Claude in Chrome
        <select value={value.chrome} onChange={(e) => set({ chrome: e.target.value as SdkForm['chrome'] })}>
          <option value="">전역 설정 따름 (~/.claude.json)</option>
          <option value="on">켜기</option>
          <option value="off">끄기</option>
        </select>
      </label>
      <label>
        추가 시스템 프롬프트
        <textarea rows={2} value={value.append_prompt} onChange={(e) => set({ append_prompt: e.target.value })} placeholder="카디널 역할 프롬프트 뒤에 붙음 (예: 답은 짧게, 음성으로 읽힘)" />
      </label>
      <label>
        외부 MCP 서버 (JSON)
        <textarea rows={4} className="mono" value={value.mcp} onChange={(e) => set({ mcp: e.target.value })} placeholder={MCP_PLACEHOLDER} spellCheck={false} />
        {redacted && <span className="hint">env/headers 의 *** 는 가려진 값. 그대로 두면 원래 값을 씀</span>}
      </label>
      <div className="row wrap">
        <label className="check" title="위 MCP 서버(+ cardinal)만. 사용자 설정·프로젝트 .mcp.json·claude.ai 커넥터·플러그인 MCP 는 안 붙음">
          <input type="checkbox" checked={value.strict_mcp_config} onChange={(e) => set({ strict_mcp_config: e.target.checked })} /> 위 MCP 만 쓰기 (strict)
        </label>
        <label className="check" title="글자 단위 StreamEvent 를 /ws/sdk 로 (음성 합성 등). 대화 탭에서도 글자가 바로 보임">
          <input type="checkbox" checked={value.partial} onChange={(e) => set({ partial: e.target.checked })} /> 글자 단위 스트리밍
        </label>
        <label className="check" title="서버가 다시 뜰 때 이 세션을 이어서 자동으로 띄움">
          <input type="checkbox" checked={value.resume_on_start} onChange={(e) => set({ resume_on_start: e.target.checked })} /> 서버 시작 때 자동 재개
        </label>
      </div>

      <details className="more">
        <summary>고급 옵션</summary>
        <div className="grid2">
          <label>
            예비 모델
            <input value={value.fallback_model} onChange={(e) => set({ fallback_model: e.target.value })} placeholder="기본 모델이 안 될 때" />
          </label>
          <label>
            effort
            <select value={value.effort} onChange={(e) => set({ effort: e.target.value as Effort | '' })}>
              <option value="">기본</option>
              {EFFORTS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
          <label>
            허용 도구 (공백 구분)
            <input value={value.allowed_tools} onChange={(e) => set({ allowed_tools: e.target.value })} placeholder="예: Bash(git *) mcp__tts" />
          </label>
          <label>
            금지 도구 (공백 구분)
            <input value={value.disallowed_tools} onChange={(e) => set({ disallowed_tools: e.target.value })} placeholder="예: WebFetch" />
          </label>
          <label>
            최대 턴 수
            <input type="number" min={1} value={value.max_turns} onChange={(e) => set({ max_turns: e.target.value })} placeholder="제한 없음" />
          </label>
          <label>
            최대 비용 (USD)
            <input type="number" min={0} step="0.01" value={value.max_budget_usd} onChange={(e) => set({ max_budget_usd: e.target.value })} placeholder="제한 없음" />
          </label>
          <label title="이 시간 안에 사람 답이 없으면 '스스로 판단해서 진행' 으로 돌려줌">
            질문 답 제한 시간 (초)
            <input type="number" min={1} value={value.question_timeout_s} onChange={(e) => set({ question_timeout_s: e.target.value })} placeholder="무한히 기다림" />
          </label>
        </div>
        <label>
          추가 폴더 (한 줄에 하나, 절대 경로)
          <textarea rows={2} className="mono" value={value.add_dirs} onChange={(e) => set({ add_dirs: e.target.value })} spellCheck={false} />
        </label>
        <label>
          환경변수 (KEY=VALUE, 한 줄에 하나)
          <textarea rows={2} className="mono" value={value.env} onChange={(e) => set({ env: e.target.value })} spellCheck={false} />
          <span className="hint">DB 에 그대로 저장돼요 (목록에선 가림). API 키는 서버 환경변수로 주는 게 안전</span>
        </label>
      </details>
    </div>
  );
}
