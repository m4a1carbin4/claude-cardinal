import { useEffect, useRef, useState } from 'react';
import { wsUrl } from './api';

// 끊기면 다시 붙는 JSON 웹소켓 구독. onMessage 는 최신 걸 쓰도록 ref 로 들고 있음
export function useJsonSocket(path: string | null, onMessage: (msg: any) => void): boolean {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    if (!path) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      ws = new WebSocket(wsUrl(path));
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

  return connected;
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
