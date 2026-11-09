import type { DialogueLine } from '../core/types';

export interface DialogueOptions {
  /** Characters per second for the typewriter effect. */
  cps?: number;
  /** Default time a finished line stays visible. */
  holdMs?: number;
  defaultSpeaker?: string;
}

/** Per-line overrides, used by the agent director. */
export interface SayOptions {
  cps?: number;
  holdMs?: number;
  /** Keep the line up until this resolves (e.g. externally played audio) instead of playing line.voice. */
  until?: Promise<void>;
  /** Allow clicking the box to skip / dismiss. Default true. */
  skippable?: boolean;
  /** Report speaking through onSpeaking (drives lip flap). Default true. */
  speaking?: boolean;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Typewriter text box. A new line interrupts the current one; clicking skips typing, then dismisses. */
export class DialogueBox {
  readonly element: HTMLDivElement;
  /** Called when the character starts / stops speaking (typing, or voice still playing). */
  onSpeaking: ((speaking: boolean) => void) | null = null;
  private speakerEl: HTMLDivElement;
  private textEl: HTMLDivElement;
  private token = 0;
  private audio: HTMLAudioElement | null = null;
  private skip: (() => void) | null = null;

  constructor(private options: DialogueOptions = {}) {
    this.element = document.createElement('div');
    this.element.className = 'ba-dialogue';
    this.speakerEl = document.createElement('div');
    this.speakerEl.className = 'ba-dialogue__speaker';
    this.textEl = document.createElement('div');
    this.textEl.className = 'ba-dialogue__text';
    this.element.append(this.speakerEl, this.textEl);
    this.element.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.skip?.();
    });
  }

  async say(line: DialogueLine, options: SayOptions = {}): Promise<void> {
    const token = ++this.token;
    const cps = options.cps ?? this.options.cps ?? 32;
    const holdMs = options.holdMs ?? line.holdMs ?? this.options.holdMs ?? 2400;
    const skippable = options.skippable ?? true;
    const speaking = options.speaking ?? true;
    const skip = () => {
      if (skippable) return this.skippable();
      this.skip = null;
      return new Promise<void>(() => {});
    };
    this.stopAudio();
    this.element.classList.toggle('is-locked', !skippable);

    const speaker = line.speaker ?? this.options.defaultSpeaker ?? '';
    this.speakerEl.textContent = speaker;
    this.speakerEl.hidden = !speaker;
    this.textEl.textContent = '';
    this.element.classList.add('is-visible');
    if (speaking) this.onSpeaking?.(true);

    let voiceDone = options.until ?? Promise.resolve();
    if (line.voice && !options.until) {
      const audio = new Audio(line.voice);
      this.audio = audio;
      voiceDone = new Promise((resolve) => {
        audio.addEventListener('ended', () => resolve(), { once: true });
        audio.addEventListener('error', () => resolve(), { once: true });
        audio.play().catch(() => resolve());
      });
    }

    const chars = Array.from(line.text);
    let typing = true;
    const typed = new Promise<void>((resolve) => {
      let i = 0;
      const step = () => {
        if (!typing || token !== this.token) return resolve();
        this.textEl.textContent = chars.slice(0, ++i).join('');
        if (i >= chars.length) return resolve();
        setTimeout(step, 1000 / cps);
      };
      step();
    });
    await Promise.race([typed, skip()]);
    typing = false;
    if (token !== this.token) return;
    this.textEl.textContent = line.text;
    if (speaking) void voiceDone.then(() => token === this.token && this.onSpeaking?.(false));

    await Promise.race([Promise.all([delay(holdMs), voiceDone]), skip()]);
    if (token === this.token) this.hide();
  }

  hide(): void {
    this.token++;
    this.skip = null;
    this.stopAudio();
    this.onSpeaking?.(false);
    this.element.classList.remove('is-visible');
  }

  private skippable(): Promise<void> {
    return new Promise((resolve) => {
      this.skip = resolve;
    });
  }

  private stopAudio(): void {
    this.audio?.pause();
    this.audio = null;
  }
}
