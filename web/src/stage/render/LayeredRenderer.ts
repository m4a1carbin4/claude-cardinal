import type { LookPose, Vec2 } from '../core/types';
import type { CharacterRenderer } from './CharacterRenderer';
import { sampleTrack, type Keyframe, type LayerTransform } from './clip';

export interface FollowWeights {
  /** Pixels per unit of pose.x. */
  x?: number;
  /** Pixels per unit of pose.y. */
  y?: number;
  /** Degrees per unit of pose.x. */
  rot?: number;
}

export interface LayerDef {
  id: string;
  /** Default image. Every layer image shares the model's full canvas size (like a PSD export). */
  src: string;
  /** Alternate images selected by clip keyframes, e.g. { closed: 'eyes_closed.png' }. */
  states?: Record<string, string>;
  /** Clip tracks keyed by any of these names also drive this layer. */
  groups?: string[];
  /** Rotation/scale origin in model pixels. Defaults to the model pivot. */
  pivot?: Vec2;
  base?: Partial<LayerTransform>;
  /** How strongly this layer follows each look axis. */
  follow?: Partial<Record<keyof LookPose, FollowWeights>>;
}

export interface ClipDef {
  duration: number;
  /** Keyed by layer id or group name. */
  tracks: Record<string, Keyframe[]>;
}

export interface LayeredModel {
  width: number;
  height: number;
  pivot?: Vec2;
  /** Back to front. */
  layers: LayerDef[];
  clips: Record<string, ClipDef>;
}

interface LayerNode {
  def: LayerDef;
  img: HTMLImageElement;
  state: string | undefined;
  trackKeys: string[];
}

interface Playing {
  clip: ClipDef | null;
  t: number;
  loop: boolean;
  done: boolean;
  resolve: (finished: boolean) => void;
}

const FALLBACK_DURATION = 1000;

function preload(src: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = src;
  });
}

/** Renders a character as stacked images animated by keyframe clips and the look pose. */
export class LayeredRenderer implements CharacterRenderer {
  readonly element: HTMLDivElement;
  private inner: HTMLDivElement;
  private nodes: LayerNode[] = [];
  private playing: Playing | null = null;
  private pose: LookPose | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(private model: LayeredModel) {
    for (const clip of Object.values(model.clips)) {
      for (const keys of Object.values(clip.tracks)) keys.sort((a, b) => a.t - b.t);
    }
    this.element = document.createElement('div');
    this.element.className = 'ba-char';
    this.element.style.aspectRatio = `${model.width} / ${model.height}`;
    this.inner = document.createElement('div');
    this.inner.className = 'ba-char__inner';
    this.inner.style.width = `${model.width}px`;
    this.inner.style.height = `${model.height}px`;
    this.element.append(this.inner);
  }

  async mount(container: HTMLElement): Promise<void> {
    const sources = this.model.layers.flatMap((l) => [l.src, ...Object.values(l.states ?? {})]);
    await Promise.all(sources.map(preload));

    const modelPivot = this.model.pivot ?? { x: this.model.width / 2, y: this.model.height };
    for (const def of this.model.layers) {
      const img = document.createElement('img');
      img.className = 'ba-char__layer';
      img.alt = '';
      img.draggable = false;
      img.src = def.src;
      img.width = this.model.width;
      img.height = this.model.height;
      const pivot = def.pivot ?? modelPivot;
      img.style.transformOrigin = `${pivot.x}px ${pivot.y}px`;
      this.inner.append(img);
      this.nodes.push({ def, img, state: undefined, trackKeys: [def.id, ...(def.groups ?? [])] });
    }

    container.append(this.element);
    this.resizeObserver = new ResizeObserver(() => {
      this.inner.style.transform = `scale(${this.element.clientWidth / this.model.width})`;
    });
    this.resizeObserver.observe(this.element);
    this.update(0);
  }

  play(clip: string, options: { loop?: boolean } = {}): Promise<boolean> {
    this.playing?.resolve(false);
    const def = this.model.clips[clip] ?? null;
    if (!def) console.warn(`[LayeredRenderer] unknown clip "${clip}"`);
    return new Promise((resolve) => {
      this.playing = { clip: def, t: 0, loop: !!options.loop, done: false, resolve };
    });
  }

  setLook(pose: LookPose): void {
    this.pose = pose;
  }

  update(dtMs: number): void {
    const playing = this.playing;
    if (playing && !playing.done) {
      playing.t += dtMs;
      const duration = playing.clip?.duration ?? FALLBACK_DURATION;
      if (playing.t >= duration) {
        if (playing.loop) {
          playing.t %= duration;
        } else {
          playing.t = duration;
          playing.done = true;
          playing.resolve(true);
        }
      }
    }
    for (const node of this.nodes) this.applyNode(node, playing);
  }

  toLocal(clientX: number, clientY: number): Vec2 {
    const rect = this.element.getBoundingClientRect();
    return { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height };
  }

  destroy(): void {
    this.playing?.resolve(false);
    this.playing = null;
    this.resizeObserver?.disconnect();
    this.element.remove();
  }

  private applyNode(node: LayerNode, playing: Playing | null): void {
    const { def, img } = node;
    let x = def.base?.x ?? 0;
    let y = def.base?.y ?? 0;
    let rot = def.base?.rot ?? 0;
    let sx = def.base?.sx ?? 1;
    let sy = def.base?.sy ?? 1;
    let alpha = def.base?.alpha ?? 1;

    if (this.pose && def.follow) {
      for (const axis of ['head', 'eye', 'body', 'scene'] as const) {
        const w = def.follow[axis];
        if (!w) continue;
        const p = this.pose[axis];
        x += (w.x ?? 0) * p.x;
        y += (w.y ?? 0) * p.y;
        rot += (w.rot ?? 0) * p.x;
      }
    }

    let state: string | undefined;
    if (playing?.clip) {
      for (const key of node.trackKeys) {
        const keys = playing.clip.tracks[key];
        if (!keys) continue;
        const s = sampleTrack(keys, playing.t);
        x += s.tf.x;
        y += s.tf.y;
        rot += s.tf.rot;
        sx *= s.tf.sx;
        sy *= s.tf.sy;
        alpha += s.tf.alpha;
        if (s.state !== undefined) state = s.state;
      }
    }

    if (state !== node.state) {
      node.state = state;
      img.src = (state !== undefined && def.states?.[state]) || def.src;
    }
    img.style.transform = `translate(${x}px, ${y}px) rotate(${rot}deg) scale(${sx}, ${sy})`;
    img.style.opacity = String(Math.min(1, Math.max(0, alpha)));
  }
}
