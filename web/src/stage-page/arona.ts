import type { CharacterDef, SpineModel } from '../stage';

// 게임에서 뽑은 리소스. 저장소엔 없고 서버가 CARDINAL_STAGE_ASSETS(기본 ~/.cardinal/stage-assets)에서 내려줌. 재배포 금지
const BASE = '/stage-assets/arona_spr';
export const BACKGROUND = '/stage-assets/bg/BG_AronaRoom.jpg';

// 스켈레톤 좌표(y 위)로 보여줄 범위. 셋업 포즈 범위는 x -510..501, y -795..1333 → 허벅지 위로
const FRAME = { x: -560, y: -200, width: 1120, height: 1600 };

export const aronaModel: SpineModel = {
  skeleton: `${BASE}/arona_spr.skel`,
  atlas: `${BASE}/arona_spr.atlas`,
  frame: FRAME,
  defaultMix: 0.2,
  // 번들의 클립 설정(arona_spr-NN): 표정은 트랙 1 에서 크로스페이드 없이 반복, 깜빡임은 트랙 2
  clips: {
    Idle_01: { track: 0 },
    ...Object.fromEntries([...Array.from({ length: 33 }, (_, i) => String(i).padStart(2, '0')), '99'].map((n) => [n, { track: 1, mix: 0 }])),
    '01': { track: 1, mix: 0, sync: ['Eye_Close_01'] },
    Eye_Close_01: { track: 2, mix: 0 },
  },
  baseExpression: '00',
  reactionMs: 2400,
  blink: { clip: 'Eye_Close_01', track: 2, delay: [2.5, 4.5], extraLoops: [0, 1] },
  // 번들의 표정별 nameSetting
  mouth: {
    slot: 'Mouse_01',
    closed: 'Mouse_01',
    open: 'Mouse_03',
    byExpression: {
      '12': { closed: 'Mouse_01', open: 'Mouse_02' },
      '18': { closed: 'Mouse_01', open: 'Mouse_11' },
      '22': { closed: 'Mouse_06', open: 'Mouse_03' },
      '29': { closed: 'Mouse_01', open: 'Mouse_11' },
      '31': { closed: 'Mouse_01', open: 'Mouse_13' },
      '32': { closed: 'Mouse_01', open: 'Mouse_13' },
      '99': { closed: 'Mouse_01', open: 'Mouse_13' },
    },
  },
  gestures: {
    look: { bone: 'Touch_Eye_Key', hold: ['Look_01_M', 'Look_01_A'], release: ['LookEnd_01_M', 'LookEnd_01_A'], radius: 140 },
    pat: {
      bone: 'Touch_Point_Key',
      hold: ['Pat_01_M', 'Pat_01_A'],
      release: ['PatEnd_01_M', 'PatEnd_01_A'],
      radius: 90,
      follow: 'relative',
      axis: 'xy',
    },
  },
};

// 영역은 프레임 기준 0–1 좌표: nx = (x - FRAME.x) / FRAME.width, ny = 1 - (y - FRAME.y) / FRAME.height
export const aronaCharacter: CharacterDef = {
  id: 'arona',
  name: '아로나',
  reactionCooldownMs: 800,
  zones: [
    { id: 'halo', priority: 3, shape: { type: 'ellipse', cx: 0.6, cy: 0.11, rx: 0.13, ry: 0.05 } },
    { id: 'head', priority: 2, shape: { type: 'ellipse', cx: 0.5, cy: 0.3, rx: 0.2, ry: 0.135 } },
    { id: 'body', shape: { type: 'rect', x: 0.27, y: 0.45, w: 0.46, h: 0.55 } },
  ],
  gestures: [
    { zone: 'head', gesture: 'pat', dialogue: [{ text: '에헤헤… 쓰다듬어 주시는 게 최고의 보상이에요!' }] },
    // 캐릭터 밖을 누르고 있으면 눈이 따라옴
    { zone: null, gesture: 'look' },
  ],
  reactions: [
    { id: 'halo-tap', zone: 'halo', clip: '10', cooldownMs: 2500, dialogue: [{ text: '앗! 헤일로는 만지지 마세요!' }] },
    { id: 'body-tap', zone: 'body', clip: '04', dialogue: [{ text: '무슨 일 있으세요, 선생님?' }] },
  ],
  idle: { cap: 1, clips: [{ clip: 'Idle_01' }] },
  look: {
    mode: 'hover',
    anchor: { x: 0.5, y: 0.33 },
    head: { factor: 2, speed: 4, min: { x: -1, y: -1 }, max: { x: 1, y: 1 } },
    eye: { factor: 2.5, speed: 8, min: { x: -1, y: -1 }, max: { x: 1, y: 1 } },
    body: { factor: 1, speed: 2, min: { x: -1, y: -1 }, max: { x: 1, y: 1 } },
  },
  greeting: [{ text: '어서 오세요, 선생님!' }],
};
