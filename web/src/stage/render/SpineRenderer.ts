import {
  AnimationState,
  AnimationStateData,
  AssetManager,
  AtlasAttachmentLoader,
  ManagedWebGLRenderingContext,
  Physics,
  SceneRenderer,
  Skeleton,
  SkeletonBinary,
  SkeletonJson,
  Vector2,
  type Bone,
  type TextureAtlas,
  type TrackEntry,
} from '@esotericsoftware/spine-webgl';
import type { GestureKind, LookPose, Vec2 } from '../core/types';
import type { CharacterRenderer } from './CharacterRenderer';

/** How a gesture drives a "touch key" bone (BA: Touch_Eye_Key / Touch_Point_Key). */
export interface SpineGestureRig {
  bone: string;
  /** Looped while the gesture is held, one per track (e.g. ['Look_01_M', 'Look_01_A']). */
  hold: string[];
  /** Played once on release, matching `hold` track by track. */
  release: string[];
  /** Max key offset from rest, in skeleton units. */
  radius: number;
  /** 'absolute' points the key at the pointer; 'relative' follows drag distance from the press point. */
  follow?: 'absolute' | 'relative';
  /** Screen-space axes the key may move along (bones are often rotated, so this is not the bone's local axis). */
  axis?: 'xy' | 'x' | 'y';
}

/** Per-clip playback settings (BA ships these as MonoBehaviours next to each skeleton). */
export interface SpineClipConfig {
  /** 0 = body loop, 1 = face expression; BA uses 2 for blinks. */
  track: number;
  /** Crossfade in seconds. BA expressions use 0 (instant swap). */
  mix?: number;
  /** Clips started together with this one (BA: SyncPlayClipObjects). */
  sync?: string[];
}

/** Random blink loop (BA: Eye_Close_01, PlayMode random, RandomDelayMin/Max, AddRandomLoopMin/Max). */
export interface SpineBlinkConfig {
  clip: string;
  track: number;
  /** Seconds between blinks. */
  delay: [number, number];
  /** Extra back-to-back blinks per cycle (0..n), for occasional double blinks. */
  extraLoops?: [number, number];
}

/** Lip flap while talking (BA: per-expression nameSetting mouthSlotName / closedShapeName / openedShapeName). */
export interface SpineMouthConfig {
  slot: string;
  closed: string;
  open: string;
  /** Overrides per face expression clip. */
  byExpression?: Record<string, { closed: string; open: string }>;
  /** Seconds each shape is held, randomized within this range. */
  flap?: [number, number];
}

export interface SpineModel {
  /** URL of a .skel (binary) or .json skeleton. */
  skeleton: string;
  /** URL of the .atlas; page images resolve relative to it. */
  atlas: string;
  premultipliedAlpha?: boolean;
  /** Region of the skeleton (skeleton units, y up) shown in the character box. Defaults to setup-pose bounds. */
  frame?: { x: number; y: number; width: number; height: number };
  defaultMix?: number;
  clips?: Record<string, SpineClipConfig>;
  /** Face expression kept on its track whenever no reaction is showing. */
  baseExpression?: string;
  /** How long a non-base reaction (e.g. a face expression) is held before reporting finished. */
  reactionMs?: number;
  blink?: SpineBlinkConfig;
  mouth?: SpineMouthConfig;
  gestures?: Partial<Record<GestureKind, SpineGestureRig>>;
  /** Drive this bone from LookPose.eye when no gesture is active (hover eye-follow). */
  hoverLook?: { bone: string; radius: number };
}

export interface SlotState {
  slot: string;
  /** Attachment currently shown (after animation and overrides). */
  current: string | null;
  options: string[];
  /** undefined = animation-driven, null = forced hidden, string = forced attachment. */
  override: string | null | undefined;
}

/** First track used for gesture animations, above body (0), face (1) and blink (2). */
const GESTURE_TRACK = 4;

interface Pending {
  entry: TrackEntry | null;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (finished: boolean) => void;
}

interface KeyDriver {
  bone: Bone;
  current: Vector2;
  target: Vector2;
}

const rand = ([min, max]: [number, number]) => min + Math.random() * (max - min);

/** Renders a Spine 4.2 skeleton with spine-webgl, following BA's clip, blink, lip-sync and touch-key conventions. */
export class SpineRenderer implements CharacterRenderer {
  readonly element: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private context: ManagedWebGLRenderingContext | null = null;
  private assets: AssetManager | null = null;
  private renderer: SceneRenderer | null = null;
  private skeleton: Skeleton | null = null;
  private state: AnimationState | null = null;
  private frame = { x: 0, y: 0, width: 1, height: 1 };
  private pending: Pending | null = null;
  private drivers = new Map<string, KeyDriver>();
  private activeGesture: { kind: GestureKind; rig: SpineGestureRig; startWorld: Vector2 } | null = null;
  private pose: LookPose | null = null;
  private baseExpression: string | null;
  private blinkEnabled = true;
  private blinkIn = 0;
  private talking = false;
  private mouthOpen = false;
  private mouthIn = 0;
  private mouthForced: boolean | null = null;
  private overrides = new Map<string, string | null>();

  constructor(private model: SpineModel) {
    this.baseExpression = model.baseExpression ?? null;
    this.element = document.createElement('div');
    this.element.className = 'ba-char';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ba-char__canvas';
    this.element.append(this.canvas);
  }

  async mount(container: HTMLElement): Promise<void> {
    const { model } = this;
    this.context = new ManagedWebGLRenderingContext(this.canvas, { alpha: true, premultipliedAlpha: false });
    this.assets = new AssetManager(this.context);
    const binary = !model.skeleton.endsWith('.json');
    if (binary) this.assets.loadBinary(model.skeleton);
    else this.assets.loadText(model.skeleton);
    this.assets.loadTextureAtlas(model.atlas);
    await this.assets.loadAll();

    const atlas: TextureAtlas = this.assets.require(model.atlas);
    const loader = new AtlasAttachmentLoader(atlas);
    const data = binary
      ? new SkeletonBinary(loader).readSkeletonData(this.assets.require(model.skeleton))
      : new SkeletonJson(loader).readSkeletonData(this.assets.require(model.skeleton));

    const stateData = new AnimationStateData(data);
    stateData.defaultMix = model.defaultMix ?? 0.2;
    this.skeleton = new Skeleton(data);
    this.skeleton.setToSetupPose();
    this.skeleton.updateWorldTransform(Physics.update);
    this.state = new AnimationState(stateData);
    this.state.addListener({
      complete: (entry) => {
        if (this.pending?.entry === entry) this.settle(true);
      },
    });

    this.frame = model.frame ?? { x: data.x, y: data.y, width: data.width, height: data.height };
    this.element.style.aspectRatio = `${this.frame.width} / ${this.frame.height}`;

    const bones = new Set<string>(Object.values(model.gestures ?? {}).map((rig) => rig.bone));
    if (model.hoverLook) bones.add(model.hoverLook.bone);
    for (const name of bones) {
      const bone = this.skeleton.findBone(name);
      if (!bone) {
        console.warn(`[SpineRenderer] missing bone "${name}"`);
        continue;
      }
      this.drivers.set(name, { bone, current: new Vector2(), target: new Vector2() });
    }

    if (this.baseExpression) this.setTrack(this.baseExpression);
    if (model.blink) this.blinkIn = rand(model.blink.delay);

    this.renderer = new SceneRenderer(this.canvas, this.context, true);
    container.append(this.element);
  }

  play(clip: string, options: { loop?: boolean } = {}): Promise<boolean> {
    this.settle(false);
    const state = this.state;
    const animation = this.skeleton?.data.findAnimation(clip);
    if (!state || !animation) {
      console.warn(`[SpineRenderer] unknown clip "${clip}"`);
      return new Promise((resolve) => setTimeout(() => resolve(true), 1000));
    }

    const track = this.clipConfig(clip).track;
    if (track === 0) {
      // Body loop: keep it running if it's already this clip so idle repeats don't pop; restore the resting face.
      const current = state.getCurrent(0);
      const entry = current?.animation?.name === clip ? current : this.setTrack(clip, true);
      if (this.baseExpression && state.getCurrent(1)?.animation?.name !== this.baseExpression) {
        this.setTrack(this.baseExpression);
      }
      return new Promise((resolve) => {
        this.pending = { entry, timer: null, resolve };
      });
    }

    // Face expressions loop in BA and have no natural end, so hold them for reactionMs.
    this.setTrack(clip, options.loop ?? true);
    const holdMs = Math.max(this.model.reactionMs ?? 2400, animation.duration * 1000);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(true), holdMs);
      this.pending = { entry: null, timer, resolve };
    });
  }

  setLook(pose: LookPose): void {
    this.pose = pose;
  }

  setTalking(talking: boolean): void {
    this.talking = talking;
    this.mouthIn = 0;
    if (!talking) this.mouthOpen = false;
  }

  setMouthOpen(open: boolean | null): void {
    this.mouthForced = open;
  }

  gesture(kind: GestureKind, phase: 'start' | 'move' | 'end', point: Vec2): void {
    const rig = this.model.gestures?.[kind];
    const state = this.state;
    if (!rig || !state) return;
    const world = this.toWorld(point);

    if (phase === 'start') {
      this.activeGesture = { kind, rig, startWorld: world };
      rig.hold.forEach((name, i) => state.setAnimation(GESTURE_TRACK + i, name, true));
    }
    if (this.activeGesture?.kind !== kind) return;

    if (phase === 'end') {
      this.activeGesture = null;
      rig.release.forEach((name, i) => {
        state.setAnimation(GESTURE_TRACK + i, name, false);
        state.addEmptyAnimation(GESTURE_TRACK + i, 0.15, 0);
      });
      this.drivers.get(rig.bone)?.target.set(0, 0);
      return;
    }
    this.aimKey(rig, world, this.activeGesture.startWorld);
  }

  update(dtMs: number): void {
    const { skeleton, state, renderer } = this;
    if (!skeleton || !state || !renderer) return;
    const dt = dtMs / 1000;

    if (!this.activeGesture && this.model.hoverLook && this.pose) {
      const { bone, radius } = this.model.hoverLook;
      this.drivers.get(bone)?.target.set(this.pose.eye.x * radius, -this.pose.eye.y * radius);
    }
    this.tickBlink(dt);

    state.update(dt);
    state.apply(skeleton);
    const k = 1 - Math.exp(-14 * dt);
    for (const d of this.drivers.values()) {
      d.current.x += (d.target.x - d.current.x) * k;
      d.current.y += (d.target.y - d.current.y) * k;
      d.bone.x = d.bone.data.x + d.current.x;
      d.bone.y = d.bone.data.y + d.current.y;
    }
    this.applyMouth(dt);
    this.applyOverrides();
    skeleton.update(dt);
    skeleton.updateWorldTransform(Physics.update);
    this.draw();
  }

  toLocal(clientX: number, clientY: number): Vec2 {
    const rect = this.element.getBoundingClientRect();
    return { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height };
  }

  destroy(): void {
    this.settle(false);
    this.renderer?.dispose();
    this.assets?.dispose();
    this.element.remove();
  }

  // ---- Inspection / debug controls ----

  /** Animation names in the loaded skeleton. */
  get animations(): string[] {
    return this.skeleton?.data.animations.map((a) => a.name) ?? [];
  }

  get expression(): string | null {
    return this.baseExpression;
  }

  /** Change the resting face expression (applied immediately). */
  setExpression(name: string | null): void {
    if (name && this.skeleton && !this.skeleton.data.findAnimation(name)) {
      console.warn(`[SpineRenderer] unknown expression "${name}"`);
      return;
    }
    this.baseExpression = name;
    if (!this.state) return;
    if (name) this.setTrack(name);
    else this.state.setEmptyAnimation(1, 0);
  }

  setBlinkEnabled(enabled: boolean): void {
    this.blinkEnabled = enabled;
  }

  /** Slots (optionally filtered by name) with the attachments each can show. */
  slots(filter?: RegExp): SlotState[] {
    const skeleton = this.skeleton;
    if (!skeleton) return [];
    const entries = skeleton.data.defaultSkin?.getAttachments() ?? [];
    return skeleton.slots
      .filter((slot) => !filter || filter.test(slot.data.name))
      .map((slot) => ({
        slot: slot.data.name,
        current: slot.attachment?.name ?? null,
        options: entries.filter((e) => e.slotIndex === slot.data.index).map((e) => e.name),
        override: this.overrides.has(slot.data.name) ? this.overrides.get(slot.data.name)! : undefined,
      }));
  }

  /** Force a slot's attachment (null hides it); pass undefined to return control to the animation. */
  setSlotOverride(slot: string, attachment: string | null | undefined): void {
    if (attachment === undefined) this.overrides.delete(slot);
    else this.overrides.set(slot, attachment);
  }

  clearSlotOverrides(): void {
    this.overrides.clear();
  }

  // ---- internals ----

  private clipConfig(clip: string): SpineClipConfig {
    return this.model.clips?.[clip] ?? { track: 0 };
  }

  private setTrack(clip: string, loop = true): TrackEntry {
    const state = this.state!;
    const cfg = this.clipConfig(clip);
    const entry = state.setAnimation(cfg.track, clip, loop);
    if (cfg.mix !== undefined) entry.mixDuration = cfg.mix;
    for (const name of cfg.sync ?? []) {
      if (name !== this.model.blink?.clip) this.setTrack(name, loop);
    }
    return entry;
  }

  private tickBlink(dt: number): void {
    const blink = this.model.blink;
    const state = this.state;
    if (!blink || !state || !this.blinkEnabled) return;
    this.blinkIn -= dt;
    if (this.blinkIn > 0) return;
    const extra = blink.extraLoops ? Math.round(rand(blink.extraLoops)) : 0;
    state.setAnimation(blink.track, blink.clip, false).mixDuration = 0;
    for (let i = 0; i < extra; i++) state.addAnimation(blink.track, blink.clip, false, 0).mixDuration = 0;
    state.addEmptyAnimation(blink.track, 0, 0);
    this.blinkIn = rand(blink.delay);
  }

  private applyMouth(dt: number): void {
    const mouth = this.model.mouth;
    const skeleton = this.skeleton;
    if (!mouth || !skeleton) return;
    if (this.mouthForced !== null) {
      this.mouthOpen = this.mouthForced;
    } else {
      if (!this.talking) return;
      this.mouthIn -= dt;
      if (this.mouthIn <= 0) {
        this.mouthOpen = !this.mouthOpen;
        this.mouthIn = rand(mouth.flap ?? [0.07, 0.16]);
      }
    }
    const face = this.state?.getCurrent(1)?.animation?.name ?? '';
    const shapes = mouth.byExpression?.[face] ?? mouth;
    const slot = skeleton.findSlot(mouth.slot);
    if (slot) slot.setAttachment(skeleton.getAttachment(slot.data.index, this.mouthOpen ? shapes.open : shapes.closed));
  }

  private applyOverrides(): void {
    const skeleton = this.skeleton;
    if (!skeleton) return;
    for (const [name, attachment] of this.overrides) {
      const slot = skeleton.findSlot(name);
      if (slot) slot.setAttachment(attachment ? skeleton.getAttachment(slot.data.index, attachment) : null);
    }
  }

  private settle(finished: boolean): void {
    const pending = this.pending;
    this.pending = null;
    if (pending?.timer) clearTimeout(pending.timer);
    pending?.resolve(finished);
  }

  private toWorld(p: Vec2): Vector2 {
    const f = this.frame;
    return new Vector2(f.x + p.x * f.width, f.y + (1 - p.y) * f.height);
  }

  private aimKey(rig: SpineGestureRig, world: Vector2, startWorld: Vector2): void {
    const driver = this.drivers.get(rig.bone);
    const parent = driver?.bone.parent;
    if (!driver || !parent) return;
    // Work out the offset in world (screen) space, then convert it into the key's parent space.
    const rest = parent.localToWorld(new Vector2(driver.bone.data.x, driver.bone.data.y));
    const offset =
      rig.follow === 'relative'
        ? new Vector2(world.x - startWorld.x, world.y - startWorld.y)
        : new Vector2(world.x - rest.x, world.y - rest.y);
    if (rig.axis === 'x') offset.y = 0;
    if (rig.axis === 'y') offset.x = 0;
    const len = Math.hypot(offset.x, offset.y);
    if (len > rig.radius) {
      offset.x *= rig.radius / len;
      offset.y *= rig.radius / len;
    }
    const local = parent.worldToLocal(new Vector2(rest.x + offset.x, rest.y + offset.y));
    driver.target.set(local.x - driver.bone.data.x, local.y - driver.bone.data.y);
  }

  private draw(): void {
    const { renderer, skeleton, canvas } = this;
    if (!renderer || !skeleton) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const gl = renderer.context.gl;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const camera = renderer.camera;
    camera.setViewport(w, h);
    camera.zoom = this.frame.width / w;
    camera.position.x = this.frame.x + this.frame.width / 2;
    camera.position.y = this.frame.y + this.frame.height / 2;
    camera.update();

    renderer.begin();
    renderer.drawSkeleton(skeleton, this.model.premultipliedAlpha ?? false);
    renderer.end();
  }
}
