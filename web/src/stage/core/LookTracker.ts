import type { LookAxis, LookConfig, LookPose, Vec2 } from './types';

const AXES = ['head', 'eye', 'body', 'scene'] as const;

const DEFAULT_SCENE: LookAxis = { factor: 1.5, speed: 2, min: { x: -1, y: -1 }, max: { x: 1, y: 1 } };

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * Smoothly turns head / eyes / body toward a target point, clamped per axis.
 * Mirrors BA's aronaTurnValue / aronaEyeTrackTurn* / aronaMoveValue fields.
 */
export class LookTracker {
  readonly pose: LookPose = {
    head: { x: 0, y: 0 },
    eye: { x: 0, y: 0 },
    body: { x: 0, y: 0 },
    scene: { x: 0, y: 0 },
  };

  constructor(private config: LookConfig) {}

  /** @param dt seconds since last update. @param target normalized point, or null to return to rest. */
  update(dt: number, target: Vec2 | null): LookPose {
    const dx = target ? target.x - this.config.anchor.x : 0;
    const dy = target ? target.y - this.config.anchor.y : 0;
    for (const key of AXES) {
      const axis = key === 'scene' ? (this.config.scene ?? DEFAULT_SCENE) : this.config[key];
      const current = this.pose[key];
      const k = 1 - Math.exp(-axis.speed * dt);
      current.x += (clamp(dx * axis.factor, axis.min.x, axis.max.x) - current.x) * k;
      current.y += (clamp(dy * axis.factor, axis.min.y, axis.max.y) - current.y) * k;
    }
    return this.pose;
  }
}
