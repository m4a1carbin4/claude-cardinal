import { Emitter } from './Emitter';
import { pickZone } from './hitTest';
import { weightedPick, type Random } from './random';
import type { CharacterDef, DialogueLine, GestureDef, GestureKind, ReactionDef, TriggerKind, Vec2 } from './types';

export interface ControllerEvents {
  /** Renderer should play this clip once and report back through clipFinished(). */
  play: { clip: string; kind: 'idle' | 'reaction' };
  reaction: { reaction: ReactionDef; zone: string; trigger: TriggerKind };
  gesture: { kind: GestureKind; phase: 'start' | 'move' | 'end'; point: Vec2 };
  dialogue: DialogueLine;
  hover: { zone: string | null };
}

interface Press {
  zone: string | null;
  start: Vec2;
  at: number;
  /** A reaction already fired for this press (hold or drag), so release won't tap. */
  fired: boolean;
  holdTried: boolean;
  dragged: boolean;
  gesture: GestureDef | null;
}

/**
 * Renderer-agnostic touch → reaction state machine.
 *
 * Mirrors the BA lobby controller: PressDown / PressRelease / TouchMovementCalculate,
 * per-zone reactions (faceTouched / hairTouched), reactionCooltime, and idle cycling
 * (idlePlayCount vs. idleCap) with forceIdle once a reaction clip ends.
 * All times are caller-supplied milliseconds, so it is deterministic under test.
 */
export class InteractionController extends Emitter<ControllerEvents> {
  private state: 'stopped' | 'idle' | 'reacting' = 'stopped';
  private idleClip: string | null = null;
  private idlePlayCount = 0;
  private current: ReactionDef | null = null;
  private lastReactionAt = -Infinity;
  private reactionUsedAt = new Map<string, number>();
  private press: Press | null = null;
  private hoverZone: string | null = null;

  constructor(
    readonly character: CharacterDef,
    private random: Random = Math.random,
  ) {
    super();
  }

  get isReacting(): boolean {
    return this.state === 'reacting';
  }

  get currentReaction(): ReactionDef | null {
    return this.current;
  }

  start(): void {
    this.state = 'idle';
    this.pickIdle();
    this.playIdle();
    const greeting = this.pickLine(this.character.greeting);
    if (greeting) this.emit('dialogue', greeting);
  }

  stop(): void {
    this.state = 'stopped';
    this.press = null;
  }

  zoneAt(p: Vec2): string | null {
    return pickZone(this.character.zones, p)?.id ?? null;
  }

  pointerDown(p: Vec2, now: number): void {
    const zone = this.zoneAt(p);
    const gesture = (this.state !== 'stopped' && this.character.gestures?.find((g) => g.zone === zone)) || null;
    this.press = { zone, start: p, at: now, fired: false, holdTried: false, dragged: false, gesture };
    if (gesture) this.emit('gesture', { kind: gesture.gesture, phase: 'start', point: p });
  }

  pointerMove(p: Vec2, now: number): void {
    const zone = this.zoneAt(p);
    if (zone !== this.hoverZone) {
      this.hoverZone = zone;
      this.emit('hover', { zone });
    }
    const press = this.press;
    if (!press) return;
    if (press.gesture) this.emit('gesture', { kind: press.gesture.gesture, phase: 'move', point: p });
    if (press.dragged) return;
    const threshold = this.character.dragThreshold ?? 0.03;
    if (Math.hypot(p.x - press.start.x, p.y - press.start.y) < threshold) return;
    press.dragged = true;
    if (!press.fired && !press.gesture && press.zone) press.fired = this.trigger('drag', press.zone, now);
  }

  pointerUp(p: Vec2, now: number): void {
    const press = this.press;
    this.press = null;
    if (!press) return;
    if (press.gesture) {
      this.emit('gesture', { kind: press.gesture.gesture, phase: 'end', point: p });
      if (press.dragged || now - press.at >= (press.gesture.minMs ?? 250)) {
        const line = this.pickLine(press.gesture.dialogue);
        if (line) this.emit('dialogue', line);
        return;
      }
    }
    if (!press.fired && !press.dragged && press.zone) this.trigger('tap', press.zone, now);
  }

  pointerLeave(): void {
    if (this.hoverZone !== null) {
      this.hoverZone = null;
      this.emit('hover', { zone: null });
    }
  }

  pointerCancel(): void {
    const press = this.press;
    this.press = null;
    if (press?.gesture) this.emit('gesture', { kind: press.gesture.gesture, phase: 'end', point: press.start });
  }

  /** Call every frame; detects holds. */
  tick(now: number): void {
    const press = this.press;
    if (!press || press.gesture || press.fired || press.holdTried || press.dragged || !press.zone) return;
    if (now - press.at < (this.character.holdMs ?? 600)) return;
    press.holdTried = true;
    press.fired = this.trigger('hold', press.zone, now);
  }

  /** Fire a reaction directly (e.g. from a UI button or script). Returns false if nothing matched or on cooldown. */
  trigger(kind: TriggerKind, zone: string, now: number): boolean {
    if (this.state === 'stopped') return false;
    if (now - this.lastReactionAt < (this.character.reactionCooldownMs ?? 0)) return false;

    const ready = this.character.reactions.filter(
      (r) =>
        (r.zone === zone || r.zone === '*') &&
        (r.trigger ?? 'tap') === kind &&
        now - (this.reactionUsedAt.get(r.id) ?? -Infinity) >= (r.cooldownMs ?? 0),
    );
    const specific = ready.filter((r) => r.zone === zone);
    const reaction = weightedPick(specific.length ? specific : ready, this.random);
    if (!reaction) return false;

    this.state = 'reacting';
    this.current = reaction;
    this.lastReactionAt = now;
    this.reactionUsedAt.set(reaction.id, now);
    this.emit('reaction', { reaction, zone, trigger: kind });
    this.emit('play', { clip: reaction.clip, kind: 'reaction' });
    const line = this.pickLine(reaction.dialogue);
    if (line) this.emit('dialogue', line);
    return true;
  }

  /** Renderer reports a non-looping clip reached its end. */
  clipFinished(clip: string): void {
    if (this.state === 'reacting' && this.current?.clip === clip) {
      this.forceIdle();
    } else if (this.state === 'idle' && clip === this.idleClip) {
      this.idlePlayCount++;
      if (this.idlePlayCount >= this.character.idle.cap) this.pickIdle();
      this.playIdle();
    }
  }

  forceIdle(): void {
    if (this.state === 'stopped') return;
    this.state = 'idle';
    this.current = null;
    this.playIdle();
  }

  private pickIdle(): void {
    const clips = this.character.idle.clips;
    const pool = clips.length > 1 ? clips.filter((c) => c.clip !== this.idleClip) : clips;
    this.idleClip = weightedPick(pool, this.random)?.clip ?? null;
    this.idlePlayCount = 0;
  }

  private playIdle(): void {
    if (this.idleClip) this.emit('play', { clip: this.idleClip, kind: 'idle' });
  }

  private pickLine(lines?: DialogueLine[]): DialogueLine | null {
    if (!lines?.length) return null;
    return lines[Math.floor(this.random() * lines.length) % lines.length];
  }
}
