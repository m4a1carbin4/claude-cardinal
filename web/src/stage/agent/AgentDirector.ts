import { Emitter } from '../core/Emitter';
import type { DialogueLine } from '../core/types';
import type { SayOptions } from '../ui/DialogueBox';
import { playAudio, type AudioPlayerFactory } from './audio';
import type { AgentEvent, AgentEventResult } from './types';

export interface DialogueLike {
  say(line: DialogueLine, options?: SayOptions): Promise<void>;
  hide(): void;
}

/** The parts of a renderer the director drives; all optional so any renderer works. */
export interface DirectedRenderer {
  readonly expression?: string | null;
  setExpression?(name: string | null): void;
  setMouthOpen?(open: boolean | null): void;
}

export interface AgentDirectorOptions {
  renderer: DirectedRenderer;
  dialogue: DialogueLike | null;
  /** Emotion number → expression clip. Default: zero-padded two digits (3 → '03'). */
  emotions?: Record<number, string> | ((emotion: number) => string | null);
  player?: AudioPlayerFactory;
  /** RMS thresholds for opening / closing the mouth from audio (hysteresis). */
  mouth?: { openAt?: number; closeAt?: number };
  /** Hold after audio-backed lines end, before the next event. Default 800 ms. */
  audioHoldMs?: number;
}

export interface AgentDirectorEvents {
  start: { id: string; event: AgentEvent };
  end: AgentEventResult;
  /** True while any event is playing or queued. */
  busy: boolean;
}

interface Queued {
  id: string;
  event: AgentEvent;
  resolve: (result: AgentEventResult) => void;
}

const MOUTH_TICK_MS = 33;

/**
 * Plays agent events one at a time: emotion → face expression, audio with level-driven lip sync,
 * text in the dialogue box (typing paced to the audio when its length is known).
 */
export class AgentDirector extends Emitter<AgentDirectorEvents> {
  private queue: Queued[] = [];
  private current: { id: string; stop: () => void } | null = null;
  private seq = 0;
  private player: AudioPlayerFactory;

  constructor(private options: AgentDirectorOptions) {
    super();
    this.player = options.player ?? playAudio;
  }

  get busy(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  get currentId(): string | null {
    return this.current?.id ?? null;
  }

  /** Queue an event. Resolves when it has finished playing (or was interrupted). */
  play(event: AgentEvent): Promise<AgentEventResult> {
    const id = event.id ?? `event-${++this.seq}`;
    const wasBusy = this.busy;
    return new Promise((resolve) => {
      this.queue.push({ id, event, resolve });
      if (!wasBusy) this.emit('busy', true);
      if (!this.current) void this.next();
    });
  }

  /** Stop the current event and drop everything queued. */
  interrupt(): void {
    for (const item of this.queue.splice(0)) item.resolve({ id: item.id, interrupted: true });
    if (this.current) this.current.stop();
    else this.emit('busy', false);
  }

  private resolveEmotion(emotion: number): string | null {
    const map = this.options.emotions;
    if (typeof map === 'function') return map(emotion);
    if (map) return map[emotion] ?? null;
    return String(emotion).padStart(2, '0');
  }

  private async next(): Promise<void> {
    const item = this.queue.shift();
    if (!item) {
      this.emit('busy', false);
      return;
    }
    let stop!: () => void;
    const stopped = new Promise<'stopped'>((resolve) => (stop = () => resolve('stopped')));
    this.current = { id: item.id, stop };
    this.emit('start', { id: item.id, event: item.event });

    const interrupted = (await this.run(item.event, stopped)) === 'stopped';

    this.current = null;
    const result = { id: item.id, interrupted };
    this.emit('end', result);
    item.resolve(result);
    void this.next();
  }

  private async run(event: AgentEvent, stopped: Promise<'stopped'>): Promise<'done' | 'stopped'> {
    const { renderer, dialogue } = this.options;
    const previous = renderer.expression ?? null;
    const expression = event.emotion != null ? this.resolveEmotion(event.emotion) : null;
    if (expression) renderer.setExpression?.(expression);

    const playback = event.audio ? this.player(event.audio) : null;
    const audioDone = playback?.done ?? Promise.resolve();

    let mouthTimer: ReturnType<typeof setInterval> | null = null;
    if (playback && renderer.setMouthOpen) {
      const openAt = this.options.mouth?.openAt ?? 0.035;
      const closeAt = this.options.mouth?.closeAt ?? 0.02;
      let open = false;
      mouthTimer = setInterval(() => {
        const level = playback.level();
        if (!open && level > openAt) open = true;
        else if (open && level < closeAt) open = false;
        renderer.setMouthOpen!(open);
      }, MOUTH_TICK_MS);
    }

    const shown = (async () => {
      if (!event.text || !dialogue) return audioDone;
      // Pace typing to the audio when its length is known quickly; otherwise use the default speed.
      const seconds = playback
        ? await Promise.race([playback.duration, new Promise<null>((r) => setTimeout(() => r(null), 300))])
        : null;
      const cps = seconds ? Math.min(60, Math.max(8, Array.from(event.text).length / (seconds * 0.85))) : undefined;
      await dialogue.say(
        { text: event.text, speaker: event.speaker },
        {
          cps,
          until: audioDone,
          holdMs: event.holdMs ?? (playback ? (this.options.audioHoldMs ?? 800) : undefined),
          skippable: false,
          speaking: !playback,
        },
      );
    })();

    const outcome = await Promise.race([Promise.all([audioDone, shown]).then(() => 'done' as const), stopped]);

    if (mouthTimer) clearInterval(mouthTimer);
    renderer.setMouthOpen?.(null);
    playback?.stop();
    if (outcome === 'stopped') dialogue?.hide();
    if (expression) renderer.setExpression?.(previous);
    return outcome;
  }
}
