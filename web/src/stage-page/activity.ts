// 관리자 세션이 지금 뭘 하는지를 캐릭터 옆 배지로 보여 줌 (대기 / 생각 중 / 도구 쓰는 중 / 답 필요).
// 패널을 숨기거나 폰의 작은 화면에서도 보이게 캐릭터 머리 옆에 붙이고, 답이 필요하거나 긴 작업이 끝났을 때는
// 탭 제목·앱 배지·알림음으로도 알림 (다른 탭/앱에 가 있어도 알아챔).

export type ActivityKind = 'idle' | 'thinking' | 'working' | 'waiting' | 'off';

export interface SessionState {
  alive?: boolean;
  state?: string; // idle | busy | waiting | ended ...
  tool?: string | null;
}

// 긴 작업이 끝났다고 알릴 최소 시간
const LONG_TASK_MS = 15_000;
// 캐릭터 프레임 안 위치 (0–1): 머리 오른쪽 위, 헤일로 옆
const ANCHOR = { x: 0.72, y: 0.17 };

export function kindOf(s: SessionState): ActivityKind {
  if (s.alive === false || s.state === 'ended') return 'off';
  if (s.state === 'waiting') return 'waiting';
  if (s.state === 'busy') return s.tool ? 'working' : 'thinking';
  return 'idle';
}

// mcp__cardinal__session_new → session_new, 너무 길면 줄임
export function toolLabel(tool: string): string {
  const short = tool.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
  return short.length > 22 ? `${short.slice(0, 21)}…` : short;
}

export interface ActivityOptions {
  /** 캐릭터가 그려지는 칸 (.ba-stage__character): 배지를 이 칸의 머리 옆에 붙임 */
  anchor: HTMLElement;
  /** 알림음을 낼지 (체크박스) */
  sound: () => boolean;
  baseTitle: string;
}

export function createActivity({ anchor, sound, baseTitle }: ActivityOptions) {
  const badge = document.createElement('div');
  badge.className = 'st-activity';
  badge.setAttribute('role', 'status');
  badge.setAttribute('aria-live', 'polite');
  const icon = document.createElement('span');
  icon.className = 'st-activity__icon';
  const label = document.createElement('span');
  label.className = 'st-activity__label';
  badge.append(icon, label);
  document.body.append(badge);

  let kind: ActivityKind = 'idle';
  let busySince = 0;
  let unseen = false; // 안 보는 사이 알림이 있었는지 (돌아오면 지움)

  function place() {
    const r = anchor.getBoundingClientRect();
    const w = badge.offsetWidth;
    let x = r.left + r.width * ANCHOR.x;
    // 폰처럼 좁은 화면에선 캐릭터 칸이 화면 밖으로 넘칠 수 있어서 화면 안으로
    x = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - w - 8));
    const y = Math.min(Math.max(8, r.top + r.height * ANCHOR.y), window.innerHeight - 120);
    badge.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
  new ResizeObserver(place).observe(anchor);
  window.addEventListener('resize', place);

  // ---- 알림 (탭 제목 · 앱 배지 · 알림음) ----
  const setTitle = (prefix: string) => {
    document.title = prefix ? `${prefix} ${baseTitle}` : baseTitle;
  };
  const setAppBadge = (on: boolean) => {
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    try {
      void (on ? nav.setAppBadge?.() : nav.clearAppBadge?.())?.catch(() => {});
    } catch {
      // 지원 안 하는 환경
    }
  };
  const clearAlerts = () => {
    unseen = false;
    if (kind !== 'waiting') setTitle('');
    setAppBadge(false);
  };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) clearAlerts();
  });
  window.addEventListener('focus', clearAlerts);

  // 알림음은 사용자가 한 번 만진 뒤에야 낼 수 있어서 (브라우저 자동재생 제한) 첫 입력에 오디오를 깨워 둠
  let ctx: AudioContext | null = null;
  const wake = () => {
    try {
      ctx ??= new AudioContext();
      void ctx.resume();
    } catch {
      // 오디오 없음
    }
  };
  window.addEventListener('pointerdown', wake, { once: true });
  window.addEventListener('keydown', wake, { once: true });

  function chime(kindOfChime: 'ask' | 'done') {
    if (!sound() || !ctx || ctx.state !== 'running') return;
    // 짧은 두 음: 질문은 올라가는 소리, 끝남은 내려가는 소리
    const [a, b] = kindOfChime === 'ask' ? [660, 880] : [880, 660];
    const t = ctx.currentTime;
    [a, b].forEach((f, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.frequency.value = f;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, t + i * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.12, t + i * 0.14 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.14 + 0.18);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t + i * 0.14);
      osc.stop(t + i * 0.14 + 0.2);
    });
  }

  function render(next: ActivityKind, tool?: string | null) {
    badge.dataset.kind = next;
    badge.classList.toggle('show', next !== 'idle' && next !== 'off');
    switch (next) {
      case 'thinking':
        icon.innerHTML = '<i></i><i></i><i></i>';
        icon.className = 'st-activity__icon dots';
        label.textContent = '생각 중';
        break;
      case 'working':
        icon.innerHTML = '';
        icon.className = 'st-activity__icon spin';
        label.textContent = tool ? toolLabel(tool) : '작업 중';
        break;
      case 'waiting':
        icon.innerHTML = '';
        icon.className = 'st-activity__icon bang';
        icon.textContent = '!';
        label.textContent = '답 필요';
        break;
    }
    requestAnimationFrame(place);
  }

  return {
    update(s: SessionState) {
      const next = kindOf(s);
      const prev = kind;
      if (next !== prev) {
        kind = next;
        const busy = next === 'thinking' || next === 'working';
        const wasBusy = prev === 'thinking' || prev === 'working';
        if (busy && !wasBusy) busySince = performance.now();
        if (next === 'waiting') {
          setTitle('❗');
          if (document.hidden) {
            unseen = true;
            setAppBadge(true);
          }
          chime('ask');
        } else if (prev === 'waiting') {
          setTitle('');
        }
        if (next === 'idle' && (wasBusy || prev === 'waiting') && busySince && performance.now() - busySince >= LONG_TASK_MS) {
          busySince = 0;
          chime('done');
          if (document.hidden) {
            unseen = true;
            setTitle('✓');
            setAppBadge(true);
          }
        }
        if (!busy && next !== 'waiting') busySince = next === 'idle' ? 0 : busySince;
        if (!unseen && next !== 'waiting') setTitle('');
      }
      // 같은 상태여도 도구 이름은 바뀔 수 있음
      render(next, s.tool);
    },
  };
}
