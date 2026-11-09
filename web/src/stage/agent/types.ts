/**
 * Audio an agent can attach to an event:
 * - string: URL of an audio file
 * - Blob / ArrayBuffer: a complete encoded file (mp3, wav, ogg, …)
 * - MediaStream: live audio (e.g. WebRTC); the event ends when its audio tracks end
 * - ReadableStream of encoded chunks (default audio/mpeg), or { stream, mimeType } — played as chunks arrive
 */
export type AudioInput =
  | string
  | Blob
  | ArrayBuffer
  | MediaStream
  | ReadableStream<Uint8Array>
  | { stream: ReadableStream<Uint8Array>; mimeType: string };

/** One thing the agent wants the character to do: say a line, play audio, show an emotion — any combination. */
export interface AgentEvent {
  /** Echoed back in start / end notifications. Generated when omitted. */
  id?: string;
  text?: string;
  audio?: AudioInput;
  /** Emotion number, mapped to a face expression for the duration of the event. */
  emotion?: number | null;
  speaker?: string;
  /** How long the finished text stays up after audio ends. */
  holdMs?: number;
}

export interface AgentEventResult {
  id: string;
  interrupted: boolean;
}
