import type { AudioInput } from './types';

/** A playing piece of audio, with a level meter for lip sync. */
export interface AudioPlayback {
  /** Resolves when playback ends, fails, or stop() is called. */
  readonly done: Promise<void>;
  /** Seconds, or null when unknown (live / streamed audio). */
  readonly duration: Promise<number | null>;
  /** Current loudness (RMS, roughly 0..0.5 for speech). */
  level(): number;
  stop(): void;
}

export type AudioPlayerFactory = (input: AudioInput) => AudioPlayback;

let sharedContext: AudioContext | null = null;

export function audioContext(): AudioContext {
  return (sharedContext ??= new AudioContext());
}

/** Browsers start audio suspended until a user gesture; call this from one (the stage does on first press). */
export function unlockAudio(): Promise<void> {
  return audioContext().resume();
}

function streamToMediaSource(stream: ReadableStream<Uint8Array>, mimeType: string, fail: () => void): string {
  const source = new MediaSource();
  source.addEventListener(
    'sourceopen',
    async () => {
      try {
        const buffer = source.addSourceBuffer(mimeType);
        const appended = () => new Promise<void>((resolve) => buffer.addEventListener('updateend', () => resolve(), { once: true }));
        const reader = stream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer.appendBuffer(value as Uint8Array<ArrayBuffer>);
          await appended();
        }
        if (source.readyState === 'open') source.endOfStream();
      } catch {
        fail();
      }
    },
    { once: true },
  );
  return URL.createObjectURL(source);
}

/** Default player: Web Audio graph (element or stream source → analyser → speakers). */
export const playAudio: AudioPlayerFactory = (input) => {
  const ctx = audioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.connect(ctx.destination);
  const samples = new Float32Array(analyser.fftSize);

  const cleanup: (() => void)[] = [];
  let finished = false;
  let resolveDone!: () => void;
  let resolveDuration!: (seconds: number | null) => void;
  const done = new Promise<void>((resolve) => (resolveDone = resolve));
  const duration = new Promise<number | null>((resolve) => (resolveDuration = resolve));
  const finish = () => {
    if (finished) return;
    finished = true;
    cleanup.forEach((fn) => fn());
    analyser.disconnect();
    resolveDuration(null);
    resolveDone();
  };

  if (input instanceof MediaStream) {
    const source = ctx.createMediaStreamSource(input);
    source.connect(analyser);
    resolveDuration(null);
    const tracks = input.getAudioTracks();
    const onEnded = () => tracks.every((t) => t.readyState === 'ended') && finish();
    tracks.forEach((t) => t.addEventListener('ended', onEnded));
    cleanup.push(() => {
      source.disconnect();
      tracks.forEach((t) => t.removeEventListener('ended', onEnded));
    });
    if (!tracks.length) finish();
  } else {
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    const source = ctx.createMediaElementSource(el);
    source.connect(analyser);
    let objectUrl: string | null = null;
    if (typeof input === 'string') {
      el.src = input;
    } else if (input instanceof Blob) {
      el.src = objectUrl = URL.createObjectURL(input);
    } else if (input instanceof ArrayBuffer) {
      el.src = objectUrl = URL.createObjectURL(new Blob([input]));
    } else {
      const { stream, mimeType } = input instanceof ReadableStream ? { stream: input, mimeType: 'audio/mpeg' } : input;
      el.src = objectUrl = streamToMediaSource(stream, mimeType, finish);
    }
    el.addEventListener('loadedmetadata', () => resolveDuration(Number.isFinite(el.duration) ? el.duration : null));
    el.addEventListener('ended', finish);
    el.addEventListener('error', finish);
    void ctx.resume().then(() => el.play()).catch(finish);
    cleanup.push(() => {
      el.pause();
      source.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    });
  }

  return {
    done,
    duration,
    stop: finish,
    level() {
      if (finished) return 0;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      return Math.sqrt(sum / samples.length);
    },
  };
};
