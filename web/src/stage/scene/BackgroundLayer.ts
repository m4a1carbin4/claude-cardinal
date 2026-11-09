import type { Vec2 } from '../core/types';

export interface BackgroundLayerDef {
  image?: string;
  video?: string;
  /** Any CSS `background` value; used when neither image nor video is set. */
  css?: string;
  /** Parallax strength: 0 = fixed, 1 = full parallaxPx. */
  depth?: number;
}

/** Stacked background layers (back to front) with pointer parallax. */
export class BackgroundLayer {
  readonly element: HTMLDivElement;
  private nodes: { el: HTMLElement; depth: number }[] = [];

  constructor(
    layers: BackgroundLayerDef[],
    private parallaxPx = 24,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'ba-bg';
    for (const def of layers) {
      const el = document.createElement('div');
      el.className = 'ba-bg__layer';
      el.style.inset = `-${parallaxPx}px`;
      if (def.video) {
        const video = document.createElement('video');
        Object.assign(video, { src: def.video, autoplay: true, muted: true, loop: true, playsInline: true });
        el.append(video);
      } else {
        el.style.background = def.image ? `center / cover no-repeat url("${def.image}")` : (def.css ?? 'none');
      }
      this.element.append(el);
      this.nodes.push({ el, depth: def.depth ?? 0 });
    }
  }

  /** @param v roughly -1..1 on each axis (LookPose.scene). */
  setParallax(v: Vec2): void {
    for (const { el, depth } of this.nodes) {
      el.style.transform = `translate3d(${-v.x * depth * this.parallaxPx}px, ${-v.y * depth * this.parallaxPx}px, 0)`;
    }
  }
}
