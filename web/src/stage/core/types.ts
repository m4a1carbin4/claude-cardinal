/** Point in normalized character space: (0,0) = top-left, (1,1) = bottom-right of the character box. */
export interface Vec2 {
  x: number;
  y: number;
}

export type HitShape =
  | { type: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { type: 'rect'; x: number; y: number; w: number; h: number }
  | { type: 'polygon'; points: [number, number][] };

/** A touchable region (BA: aronaHairCollider / aronaEyeCollider). Higher priority wins on overlap. */
export interface HitZone {
  id: string;
  shape: HitShape;
  priority?: number;
}

export type TriggerKind = 'tap' | 'hold' | 'drag';

/**
 * Continuous press-and-drag interactions (BA lobby: Look_01 / Pat_01 driven by Touch_Eye_Key / Touch_Point_Key).
 * 'look' follows the pointer with the eyes and face; 'pat' strokes the head side to side.
 */
export type GestureKind = 'look' | 'pat';

export interface GestureDef {
  /** HitZone id, or null for presses outside every zone (e.g. on the background). */
  zone: string | null;
  gesture: GestureKind;
  /** One line is spoken when the gesture ends (if it lasted at least minMs or moved). */
  dialogue?: DialogueLine[];
  /** Shorter presses that didn't move fall through to tap reactions. Default 250. */
  minMs?: number;
}

export interface DialogueLine {
  text: string;
  speaker?: string;
  /** URL of a voice clip played alongside the text. */
  voice?: string;
  /** How long the finished line stays on screen. */
  holdMs?: number;
}

export interface ReactionDef {
  id: string;
  /** HitZone id, or '*' to match any zone. Zone-specific reactions win over '*'. */
  zone: string;
  trigger?: TriggerKind;
  /** Animation clip name passed to the renderer. */
  clip: string;
  weight?: number;
  cooldownMs?: number;
  /** One line is picked at random when the reaction fires. */
  dialogue?: DialogueLine[];
}

/** BA: aronaAnimations + idlePlayCount / aronaIdleCap — an idle clip repeats `cap` times, then a new one is picked. */
export interface IdleConfig {
  clips: { clip: string; weight?: number }[];
  cap: number;
}

/** BA: turnFactor / turnSpeed / *BoundaryMin / *BoundaryMax. */
export interface LookAxis {
  factor: number;
  /** Exponential smoothing rate, 1/s. */
  speed: number;
  min: Vec2;
  max: Vec2;
}

export interface LookConfig {
  /** 'hover' follows the mouse whenever it is over the stage; 'press' only while pressed (touch-style). */
  mode: 'hover' | 'press';
  /** Point the character looks out from, usually between the eyes. */
  anchor: Vec2;
  head: LookAxis;
  eye: LookAxis;
  body: LookAxis;
  /** Drives background parallax. */
  scene?: LookAxis;
}

export interface LookPose {
  head: Vec2;
  eye: Vec2;
  body: Vec2;
  scene: Vec2;
}

export interface CharacterDef {
  id: string;
  name: string;
  zones: HitZone[];
  reactions: ReactionDef[];
  /** A zone with a gesture starts it on press instead of waiting for tap / hold / drag. */
  gestures?: GestureDef[];
  idle: IdleConfig;
  look: LookConfig;
  /** BA: reactionCooltime — minimum gap between any two reactions. */
  reactionCooldownMs?: number;
  /** Press duration that counts as a hold. */
  holdMs?: number;
  /** Pointer travel (normalized units) that turns a press into a drag. */
  dragThreshold?: number;
  greeting?: DialogueLine[];
}
