import type { InteractionController } from '../core/InteractionController';
import type { AgentDirector } from './AgentDirector';
import type { AgentEvent, AudioInput } from './types';

/**
 * WebSocket protocol between a background agent (server) and the stage (client).
 *
 * Server → client (JSON text frames):
 *   { type: 'speak', id?, text?, emotion?, speaker?, holdMs?, audio? }
 *       audio: { url } | { base64, mime? } | { stream: true, mime? }
 *       With { stream: true }, following binary frames are encoded audio chunks for this event
 *       until { type: 'audio_end', id? }.
 *   { type: 'audio_end', id? }
 *   { type: 'interrupt' }
 *
 * Client → server (JSON):
 *   { type: 'ready' }
 *   { type: 'event_start', id }  /  { type: 'event_end', id, interrupted }
 *   { type: 'touch', action: 'reaction', zone, trigger, reaction }
 *   { type: 'touch', action: 'gesture', gesture, phase: 'start' | 'end' }
 */
export type ServerMessage =
  | {
      type: 'speak';
      id?: string;
      text?: string;
      emotion?: number | null;
      speaker?: string;
      holdMs?: number;
      audio?: { url: string } | { base64: string; mime?: string } | { stream: true; mime?: string };
    }
  | { type: 'audio_end'; id?: string }
  | { type: 'interrupt' };

export type ClientMessage =
  | { type: 'ready' }
  | { type: 'event_start'; id: string }
  | { type: 'event_end'; id: string; interrupted: boolean }
  | { type: 'touch'; action: 'reaction'; zone: string; trigger: string; reaction: string }
  | { type: 'touch'; action: 'gesture'; gesture: string; phase: 'start' | 'end' };

/** The subset of WebSocket the bridge uses (so tests can pass a fake). */
export interface SocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'message', listener: (event: { data?: unknown }) => void): void;
  removeEventListener(type: 'open' | 'close' | 'message', listener: (event: { data?: unknown }) => void): void;
}

export interface BridgeTarget {
  agent: AgentDirector;
  controller: InteractionController;
}

const OPEN = 1;

function decodeBase64(base64: string, mime?: string): Blob {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new Blob([bytes], mime ? { type: mime } : undefined);
}

/** Connects a stage to an agent over WebSocket. Returns a disconnect function. */
export function connectAgentSocket(target: BridgeTarget, socket: SocketLike | string): () => void {
  const ws: SocketLike = typeof socket === 'string' ? (new WebSocket(socket) as unknown as SocketLike) : socket;
  ws.binaryType = 'arraybuffer';
  let openStream: { id: string | undefined; controller: ReadableStreamDefaultController<Uint8Array> } | null = null;

  const send = (message: ClientMessage) => {
    if (ws.readyState === OPEN) ws.send(JSON.stringify(message));
  };
  const closeStream = () => {
    try {
      openStream?.controller.close();
    } catch {
      // already closed or errored
    }
    openStream = null;
  };

  const audioFor = (msg: Extract<ServerMessage, { type: 'speak' }>): AudioInput | undefined => {
    const audio = msg.audio;
    if (!audio) return undefined;
    if ('url' in audio) return audio.url;
    if ('base64' in audio) return decodeBase64(audio.base64, audio.mime);
    closeStream();
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        openStream = { id: msg.id, controller };
      },
    });
    return { stream, mimeType: audio.mime ?? 'audio/mpeg' };
  };

  const onMessage = (event: { data?: unknown }) => {
    const { data } = event;
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      openStream?.controller.enqueue(bytes);
      return;
    }
    if (typeof data !== 'string') return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'speak': {
        const agentEvent: AgentEvent = {
          id: msg.id,
          text: msg.text,
          emotion: msg.emotion,
          speaker: msg.speaker,
          holdMs: msg.holdMs,
          audio: audioFor(msg),
        };
        void target.agent.play(agentEvent);
        break;
      }
      case 'audio_end':
        if (!msg.id || msg.id === openStream?.id) closeStream();
        break;
      case 'interrupt':
        closeStream();
        target.agent.interrupt();
        break;
    }
  };
  const onOpen = () => send({ type: 'ready' });

  const disposers = [
    target.agent.on('start', ({ id }) => send({ type: 'event_start', id })),
    target.agent.on('end', ({ id, interrupted }) => send({ type: 'event_end', id, interrupted })),
    target.controller.on('reaction', ({ reaction, zone, trigger }) =>
      send({ type: 'touch', action: 'reaction', zone, trigger, reaction: reaction.id }),
    ),
    target.controller.on('gesture', ({ kind, phase }) => {
      if (phase !== 'move') send({ type: 'touch', action: 'gesture', gesture: kind, phase });
    }),
  ];
  ws.addEventListener('message', onMessage);
  ws.addEventListener('open', onOpen);
  if (ws.readyState === OPEN) onOpen();

  return () => {
    disposers.forEach((dispose) => dispose());
    ws.removeEventListener('message', onMessage);
    ws.removeEventListener('open', onOpen);
    closeStream();
    if (typeof socket === 'string') ws.close();
  };
}
