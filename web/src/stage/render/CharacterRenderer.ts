import type { GestureKind, LookPose, Vec2 } from '../core/types';

/**
 * What the stage needs from a character renderer. Implement this to plug in
 * Spine (spine-ts), Live2D (pixi-live2d-display), a three.js/VRM model, or plain images.
 */
export interface CharacterRenderer {
  /** The character box. Hit zones are expressed in normalized coordinates of this element. */
  readonly element: HTMLElement;
  mount(container: HTMLElement): Promise<void>;
  /** Plays a clip once (or looped). Resolves true when it reaches the end, false if interrupted. */
  play(clip: string, options?: { loop?: boolean }): Promise<boolean>;
  setLook(pose: LookPose): void;
  /** Optional: continuous press-and-drag interaction. `point` is in normalized character coordinates. */
  gesture?(kind: GestureKind, phase: 'start' | 'move' | 'end', point: Vec2): void;
  /** Optional: lip flap while a dialogue line is being spoken. */
  setTalking?(talking: boolean): void;
  /** Optional: drive the mouth directly (e.g. from audio level); null returns it to animation / flap control. */
  setMouthOpen?(open: boolean | null): void;
  /** Optional: current resting face expression, and a way to change it (used for agent emotions). */
  readonly expression?: string | null;
  setExpression?(name: string | null): void;
  /** @param dtMs milliseconds since last frame. */
  update(dtMs: number): void;
  /** Client (page) coordinates → normalized character coordinates. */
  toLocal(clientX: number, clientY: number): Vec2;
  destroy(): void;
}
