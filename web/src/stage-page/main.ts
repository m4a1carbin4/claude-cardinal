// 스테이지 페이지: 캐릭터(BA-REA 스테이지 모듈)를 관리자 세션에 바로 붙임 (docs/stage.md).
// 사람이 쓴 말 → /ws/sdk/<관리자> 로 보냄, 관리자 답 → 캐릭터 대사
import { ApiError, api, currentToken, wsUrl } from '../api';
import { BackgroundLayer, CharacterStage, SpineRenderer } from '../stage';
import { mountPanelToggle } from '../stage/panelToggle';
import { aronaCharacter, aronaModel, BACKGROUND } from './arona';
import { lastEmotion, toLines } from './lines';
import { mountMic, setReplying } from './mic';
import './stage.css';

// 관리자가 스테이지에서 온 말인지 알아보는 표시 (관리자 프롬프트에 같은 말이 있음)
const MARK = '[스테이지]';
const READ_ALL_KEY = 'cardinal.stage.readAll';
const WAKE_REPLIES = [
  { text: '네, 선생님! 말씀하세요.', emotion: 20 },
  { text: '부르셨어요, 선생님?', emotion: 2 },
  { text: '네! 듣고 있어요.', emotion: 3 },
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusDot = $<HTMLSpanElement>('status-dot');
const statusText = $<HTMLSpanElement>('status-text');
const log = $<HTMLDivElement>('log');
const form = $<HTMLFormElement>('say');
const input = $<HTMLTextAreaElement>('say-text');
const stopBtn = $<HTMLButtonElement>('stop');
const readAll = $<HTMLInputElement>('read-all');
const chatLink = $<HTMLAnchorElement>('chat-link');

// spine 로더는 헤더를 못 붙여서 리소스 요청엔 쿠키로 토큰을 실어 보냄
const token = currentToken();
if (token) document.cookie = `cardinal_token=${encodeURIComponent(token)}; path=/stage-assets; SameSite=Strict`;

try {
  readAll.checked = localStorage.getItem(READ_ALL_KEY) === '1';
} catch {
  // 무시
}
readAll.addEventListener('change', () => {
  try {
    localStorage.setItem(READ_ALL_KEY, readAll.checked ? '1' : '0');
  } catch {
    // 무시
  }
});

function note(who: 'me' | 'admin' | 'sys', text: string) {
  const row = document.createElement('div');
  row.className = `log-row ${who}`;
  row.textContent = text;
  log.append(row);
  while (log.children.length > 60) log.firstElementChild?.remove();
  log.scrollTop = log.scrollHeight;
}

function setStatus(kind: 'ok' | 'busy' | 'off' | 'warn', text: string) {
  statusDot.className = `dot ${kind}`;
  statusText.textContent = text;
}

const renderer = new SpineRenderer(aronaModel);
const stage = new CharacterStage({
  container: $('stage'),
  character: aronaCharacter,
  renderer,
  background: new BackgroundLayer([{ image: BACKGROUND, depth: 0.5 }], 20),
});
mountPanelToggle([$('panel')]);
// 개발자 도구에서 만져 보기용: stage.agent.play({ text, emotion }), renderer.setExpression('05')
Object.assign(window, { stage, renderer });

// ---- 관리자 세션 연결 ----

let ws: WebSocket | null = null;
let ourTurn = false; // 지금 도는 턴이 스테이지에서 보낸 것인지
let emotion: number | null = null; // 이번 턴 표정 (문단마다 [emo:NN] 으로 바뀜)

function speak(text: string) {
  const lines = toLines(text, emotion);
  emotion = lastEmotion(lines, emotion);
  for (const l of lines) void stage.agent.play({ text: l.text, emotion: l.emotion });
}

function onMessage(m: any) {
  switch (m.type) {
    case 'hello':
    case 'state': {
      const s = m.type === 'hello' ? m.status : m;
      if (!s.alive) setStatus('off', '관리자 꺼져 있음');
      else if (s.state === 'busy') setStatus('busy', s.tool ? `작업 중 · ${s.tool}` : '생각 중…');
      else if (s.state === 'waiting') setStatus('warn', '질문 대기 · 대화 탭에서 답해 주세요');
      else setStatus('ok', '대기');
      break;
    }
    case 'turn_start':
      ourTurn = String(m.prompt ?? '').startsWith(MARK);
      emotion = null;
      setReplying(ourTurn); // 호출어: 스테이지 턴이 도는 동안과 끝난 뒤 잠깐은 이름 없이 받음
      break;
    case 'turn':
      ourTurn = false;
      setReplying(false);
      break;
    case 'pending':
      note('sys', `관리자가 묻는 중: ${m.pending?.tool ?? '질문'} → 대화 탭에서 답해 주세요`);
      break;
    case 'result':
      if (!m.ok) note('sys', `실패: ${m.error ?? ''}`);
      break;
    case 'message': {
      const msg = m.message;
      if (msg?.type !== 'AssistantMessage' || msg.parent_tool_use_id) return;
      const text = (msg.content ?? [])
        .filter((b: any) => b.type === 'TextBlock' && b.text)
        .map((b: any) => b.text as string)
        .join('\n\n');
      if (!text) return;
      note('admin', text.replace(/\[emo:\d{1,2}\]\s*/g, ''));
      if (ourTurn || readAll.checked) speak(text);
      break;
    }
  }
}

function connect(name: string) {
  let retry = 1000;
  const open = () => {
    const sock = new WebSocket(wsUrl(`/ws/sdk/${encodeURIComponent(name)}`));
    ws = sock;
    sock.onopen = () => {
      retry = 1000;
    };
    sock.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch {
        // JSON 아니면 무시
      }
    };
    sock.onclose = (e) => {
      ws = null;
      setReplying(false);
      setStatus('off', e.code === 4401 ? '토큰 필요 (메인 화면에서 입력)' : '연결 끊김 · 다시 붙는 중');
      if (e.code === 4401) return;
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 15000);
    };
  };
  open();
}

// 보냈으면 true (입력창 비우기용)
function sendText(text: string): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    note('sys', '관리자에 안 붙어 있어요');
    return false;
  }
  ws.send(JSON.stringify({ type: 'send', id: `st${Date.now().toString(36)}`, text: `${MARK} ${text}`, wait: false }));
  note('me', text);
  return true;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (text && sendText(text)) input.value = '';
});
// 음성 입력: 바로 보내기(누르는 동안·계속 듣기는 늘, 버튼은 설정 따라)면 보내고, 아니면 입력창에 이어 붙임
mountMic($('mic'), (text, send) => {
  if (send) {
    sendText(text);
    return;
  }
  input.value = input.value.trim() ? `${input.value.trimEnd()} ${text}` : text;
  input.focus();
}, () => {
  // 호출어: 이름만 불렀을 때 대답 (관리자에겐 안 보냄)
  const reply = WAKE_REPLIES[Math.floor(Math.random() * WAKE_REPLIES.length)];
  void stage.agent.play({ text: reply.text, emotion: reply.emotion });
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});
stopBtn.addEventListener('click', () => {
  stage.agent.interrupt();
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'interrupt', id: `st${Date.now().toString(36)}` }));
});

void stage.start().catch((e) => note('sys', `캐릭터를 못 불러옴: ${(e as Error).message} (docs/stage.md 의 리소스 준비 참고)`));

api.health().then(
  (h) => {
    const admin = h.admin;
    if (!admin) {
      setStatus('off', '관리자 세션 없음 (SDK 모드 서버에서만)');
      return;
    }
    chatLink.href = `/#s=${encodeURIComponent(admin.name)}`;
    chatLink.textContent = `${admin.name} 대화 탭`;
    connect(admin.name);
  },
  (e) => setStatus('off', e instanceof ApiError && e.status === 401 ? '토큰 필요 (메인 화면에서 입력)' : '서버에 못 붙음'),
);
