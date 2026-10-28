import { useCallback, useEffect, useRef, useState } from 'react';
import { wsUrl } from './api';

// 끊기면 다시 붙는 JSON 웹소켓 구독. onMessage 는 최신 걸 쓰도록 ref 로 들고 있음
export function useJsonSocket(path: string | null, onMessage: (msg: any) => void): boolean {
  return useSocket(path, onMessage).connected;
}

// 위와 같은데 보내기도 함 (/ws/sdk 처럼 명령을 받는 소켓). 안 붙어 있으면 send 가 false
export function useSocket(path: string | null, onMessage: (msg: any) => void): { connected: boolean; send: (msg: unknown) => boolean } {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onMessage);
  handler.current = onMessage;
  const sock = useRef<WebSocket | null>(null);
  const send = useCallback((msg: unknown) => {
    const ws = sock.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }, []);

  useEffect(() => {
    if (!path) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      ws = new WebSocket(wsUrl(path));
      sock.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        try {
          handler.current(JSON.parse(e.data));
        } catch {
          // JSON 아니면 무시
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [path]);

  return { connected, send };
}

// 주기적으로 다시 불러오기 (화면에 보일 때만 쓰는 용도)
export function useInterval(fn: () => void, ms: number | null) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

// 웹드라이브가 바뀌었다는 알림 (/ws/events 의 {"type":"drive","path":폴더}). App 이 받아서 창 이벤트로 뿌림
export const DRIVE_EVENT = 'cardinal:drive';
export function useDriveChanged(path: string, fn: () => void) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail === path) saved.current();
    };
    window.addEventListener(DRIVE_EVENT, on);
    return () => window.removeEventListener(DRIVE_EVENT, on);
  }, [path]);
}
