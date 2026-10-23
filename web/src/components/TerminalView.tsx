// 웹 터미널: /ws/term/<이름> 웹소켓 ↔ xterm.js (원리는 docs/web-terminal.md)
//   보내기: {"t":"i","d":입력} / {"t":"r","c":cols,"r":rows}
//   받기: 바이너리 = 터미널 출력 그대로
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { wsUrl } from '../api';

export function TerminalView({ name, readonly }: { name: string; readonly: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [reason, setReason] = useState('');

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const css = getComputedStyle(document.documentElement);
    const term = new Terminal({
      fontSize: 13,
      // 한글은 터미널 칸 2개를 씀. 고정폭 폰트에 한글이 없으면 자간이 벌어져 보여서 한글 폰트를 대체로 붙임
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "D2Coding", "Nanum Gothic Coding", "Apple SD Gothic Neo", "Noto Sans Mono CJK KR", monospace',
      cursorBlink: !readonly,
      disableStdin: readonly,
      theme: { background: css.getPropertyValue('--term-bg').trim() || '#15131a' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    setStatus('connecting');
    const params: Record<string, string | number> = { cols: term.cols, rows: term.rows };
    if (readonly) params.readonly = 1;
    const ws = new WebSocket(wsUrl(`/ws/term/${encodeURIComponent(name)}`, params));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => setStatus('open');
    ws.onmessage = (e) => term.write(new Uint8Array(e.data as ArrayBuffer));
    ws.onclose = (e) => {
      setStatus('closed');
      setReason(e.reason || String(e.code));
      term.write(`\r\n\x1b[2m[연결 끊김: ${e.reason || e.code}]\x1b[0m\r\n`);
    };

    const send = (msg: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
    const onData = term.onData((d) => send({ t: 'i', d }));
    // 칸/줄 수가 실제로 바뀔 때만 서버에 알림. 바뀔 때마다 tmux 가 화면 전체를 다시 그려서 깜빡이니까
    let last = `${term.cols}x${term.rows}`;
    const onResize = term.onResize(({ cols, rows }) => {
      const key = `${cols}x${rows}`;
      if (key === last) return;
      last = key;
      send({ t: 'r', c: cols, r: rows });
    });
    // 크기 맞추기는 한 프레임에 한 번만 (연달아 오는 크기 변화를 모아서)
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          // 숨겨진 상태면 무시
        }
      });
    });
    ro.observe(el);
    if (!readonly) term.focus();

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      onData.dispose();
      onResize.dispose();
      ws.close();
      term.dispose();
    };
  }, [name, readonly]);

  return (
    <div className="term-wrap">
      <div className="term-status">
        <span className={`dot ${status === 'open' ? 'ok' : status === 'connecting' ? 'info' : 'muted'}`} />
        {status === 'open' ? (readonly ? '관전 중 (입력 안 됨)' : '연결됨') : status === 'connecting' ? '연결 중…' : `끊김 (${reason})`}
      </div>
      <div className="term" ref={box} />
    </div>
  );
}
