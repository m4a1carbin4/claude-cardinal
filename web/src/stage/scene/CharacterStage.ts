import { AgentDirector, type AgentDirectorOptions } from '../agent/AgentDirector';
import { unlockAudio, type AudioPlayerFactory } from '../agent/audio';
import { InteractionController } from '../core/InteractionController';
import { LookTracker } from '../core/LookTracker';
import type { Random } from '../core/random';
import type { CharacterDef, HitShape, Vec2 } from '../core/types';
import type { CharacterRenderer } from '../render/CharacterRenderer';
import { DialogueBox } from '../ui/DialogueBox';
import type { BackgroundLayer } from './BackgroundLayer';

export interface StageOptions {
  container: HTMLElement;
  character: CharacterDef;
  renderer: CharacterRenderer;
  background?: BackgroundLayer;
  /** Omit for a default box, or pass null to handle the controller's 'dialogue' event yourself. */
  dialogue?: DialogueBox | null;
  debugZones?: boolean;
  random?: Random;
  /** Agent event handling (stage.agent). */
  agent?: {
    emotions?: AgentDirectorOptions['emotions'];
    player?: AudioPlayerFactory;
    mouth?: AgentDirectorOptions['mouth'];
    /** Ignore touch input while an agent event is playing or queued. Default true. */
    lockInput?: boolean;
  };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function zoneElement(shape: HitShape): SVGElement {
  switch (shape.type) {
    case 'ellipse': {
      const el = document.createElementNS(SVG_NS, 'ellipse');
      el.setAttribute('cx', String(shape.cx));
      el.setAttribute('cy', String(shape.cy));
      el.setAttribute('rx', String(shape.rx));
      el.setAttribute('ry', String(shape.ry));
      return el;
    }
    case 'rect': {
      const el = document.createElementNS(SVG_NS, 'rect');
      el.setAttribute('x', String(shape.x));
      el.setAttribute('y', String(shape.y));
      el.setAttribute('width', String(shape.w));
      el.setAttribute('height', String(shape.h));
      return el;
    }
    case 'polygon': {
      const el = document.createElementNS(SVG_NS, 'polygon');
      el.setAttribute('points', shape.points.map((p) => p.join(',')).join(' '));
      return el;
    }
  }
}

/** Composes background + character renderer + dialogue, and drives them from pointer input. */
export class CharacterStage {
  readonly controller: InteractionController;
  readonly tracker: LookTracker;
  readonly dialogue: DialogueBox | null;
  /** Queue agent events here: stage.agent.play({ text, audio, emotion }). */
  readonly agent: AgentDirector;
  private slot: HTMLDivElement;
  private zonesOverlay: SVGSVGElement | null = null;
  private pointer: Vec2 | null = null;
  private pressed = false;
  private raf = 0;
  private lastFrame = 0;
  private disposers: (() => void)[] = [];

  constructor(private options: StageOptions) {
    const { container, character } = options;
    container.classList.add('ba-stage');
    if (options.background) container.append(options.background.element);
    this.slot = document.createElement('div');
    this.slot.className = 'ba-stage__character';
    container.append(this.slot);
    this.dialogue = options.dialogue === undefined ? new DialogueBox({ defaultSpeaker: character.name }) : options.dialogue;
    if (this.dialogue) container.append(this.dialogue.element);
    this.controller = new InteractionController(character, options.random);
    this.tracker = new LookTracker(character.look);
    this.agent = new AgentDirector({
      renderer: options.renderer,
      dialogue: this.dialogue,
      emotions: options.agent?.emotions,
      player: options.agent?.player,
      mouth: options.agent?.mouth,
    });
  }

  /** True while touch input is being ignored because an agent event is playing. */
  get inputLocked(): boolean {
    return (this.options.agent?.lockInput ?? true) && this.agent.busy;
  }

  async start(): Promise<void> {
    const { renderer, container } = this.options;
    await renderer.mount(this.slot);
    this.setDebugZones(!!this.options.debugZones);
    if (this.dialogue) this.dialogue.onSpeaking = (speaking) => renderer.setTalking?.(speaking);

    this.disposers.push(
      this.controller.on('play', ({ clip }) => {
        renderer.play(clip).then((finished) => finished && this.controller.clipFinished(clip));
      }),
      this.controller.on('gesture', ({ kind, phase, point }) => renderer.gesture?.(kind, phase, point)),
      this.controller.on('dialogue', (line) => void this.dialogue?.say(line)),
      this.controller.on('hover', ({ zone }) => {
        container.style.cursor = zone && !this.inputLocked ? 'pointer' : '';
      }),
      this.agent.on('busy', () => {
        const locked = this.inputLocked;
        container.classList.toggle('is-input-locked', locked);
        if (!locked) return;
        // Drop whatever the user was doing: release gestures and stop tracking the pointer.
        this.pressed = false;
        this.pointer = null;
        this.controller.pointerCancel();
        this.controller.pointerLeave();
        container.style.cursor = '';
      }),
    );
    this.listen(container);

    this.controller.start();
    this.lastFrame = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(now - this.lastFrame, 100);
      this.lastFrame = now;
      const target = this.options.character.look.mode === 'press' && !this.pressed ? null : this.pointer;
      const pose = this.tracker.update(dt / 1000, target);
      renderer.setLook(pose);
      renderer.update(dt);
      this.options.background?.setParallax(pose.scene);
      this.controller.tick(now);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  setDebugZones(show: boolean): void {
    this.zonesOverlay?.remove();
    this.zonesOverlay = null;
    if (!show) return;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ba-zones');
    svg.setAttribute('viewBox', '0 0 1 1');
    svg.setAttribute('preserveAspectRatio', 'none');
    for (const zone of this.options.character.zones) {
      const el = zoneElement(zone.shape);
      el.setAttribute('data-zone', zone.id);
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = `${zone.id} (priority ${zone.priority ?? 0})`;
      el.append(title);
      svg.append(el);
    }
    this.options.renderer.element.append(svg);
    this.zonesOverlay = svg;
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.agent.interrupt();
    this.controller.stop();
    this.disposers.forEach((dispose) => dispose());
    this.disposers = [];
    this.options.renderer.destroy();
    this.dialogue?.hide();
    this.dialogue?.element.remove();
    this.options.background?.element.remove();
    this.slot.remove();
    this.options.container.classList.remove('ba-stage');
  }

  private listen(container: HTMLElement): void {
    const local = (e: PointerEvent) => this.options.renderer.toLocal(e.clientX, e.clientY);
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      container.addEventListener(type, fn);
      this.disposers.push(() => container.removeEventListener(type, fn));
    };

    on('pointerdown', (e) => {
      void unlockAudio().catch(() => {});
      if (this.inputLocked) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      container.setPointerCapture(e.pointerId);
      this.pressed = true;
      this.pointer = local(e);
      this.controller.pointerDown(this.pointer, performance.now());
    });
    on('pointermove', (e) => {
      if (this.inputLocked) return;
      this.pointer = local(e);
      this.controller.pointerMove(this.pointer, performance.now());
    });
    on('pointerup', (e) => {
      if (this.inputLocked) return;
      this.pressed = false;
      this.controller.pointerUp(local(e), performance.now());
      if (e.pointerType !== 'mouse') {
        this.pointer = null;
        this.controller.pointerLeave();
      }
    });
    on('pointercancel', () => {
      this.pressed = false;
      this.pointer = null;
      this.controller.pointerCancel();
    });
    on('pointerleave', () => {
      if (this.pressed) return;
      this.pointer = null;
      this.controller.pointerLeave();
    });
  }
}
