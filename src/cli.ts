import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import * as session from './session.js';
import type { SessionStatus } from './session.js';

const HELP = `cardinal — tmux + Claude Code 세션 제어

  cardinal new <name> [--role worker|master] [--prompt TEXT] [--wait] [-- <claude 인자...>]
  cardinal ls [--json]                       세션 목록 + 상태
  cardinal status <name> [--json]            한 세션 상태
  cardinal send <name> <text|-> [--wait] [--timeout SEC] [--no-enter] [--force]
                                             메시지 보내기 ('-' 면 stdin), --wait 면 끝날 때까지 기다리고 마지막 응답 출력
  cardinal keys <name> <key...>              tmux 키 그대로 전송 (예: Enter, Escape, C-c, 1)
  cardinal wait <name> [--timeout SEC]       idle/waiting/ended 될 때까지 대기
  cardinal screen <name> [--lines N]         현재 화면 (N 주면 스크롤백 포함)
  cardinal report <name> [--tools] [--json]  결과 보고: 살아있는지, 작업중/완료, 마지막 턴 응답 전체
  cardinal last <name>                       마지막 턴 응답 텍스트만
  cardinal attach <name>                     tmux에 직접 붙기
  cardinal kill <name> [--purge]             세션 종료 (--purge 면 기록도 삭제)
  cardinal serve [--host H] [--port P]       웹소켓/웹 서버 (CARDINAL_TOKEN 있으면 토큰 인증)

상태: starting → idle ⇄ busy, waiting(승인 대기), ended
세션은 전부 고정 작업 폴더에서 돔: $CARDINAL_WORKSPACE (기본 ~/.cardinal/workspace)
`;

function fail(msg: string): never {
  console.error(`cardinal: ${msg}`);
  process.exit(1);
}

async function readStdin(): Promise<string> {
  let s = '';
  for await (const c of process.stdin) s += c;
  return s.replace(/\n$/, '');
}

function ago(iso?: string): string {
  if (!iso) return '-';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

function printTable(list: SessionStatus[]) {
  if (!list.length) return console.log('(세션 없음)');
  const rows = list.map((s) => [
    s.name,
    s.role,
    s.state + (s.state === 'busy' && s.tool ? `:${s.tool}` : ''),
    ago(s.stateAt),
  ]);
  const head = ['NAME', 'ROLE', 'STATE', 'SINCE'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  for (const r of [head, ...rows]) console.log(r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd());
}

function printStatus(s: SessionStatus) {
  console.log(`${s.name}  [${s.role}]  ${s.state}${s.tool ? ` (${s.tool})` : ''}  ${ago(s.stateAt)} 전`);
  console.log(`  cwd:     ${s.cwd}`);
  console.log(`  tmux:    ${s.tmux} ${s.alive ? '' : '(죽음)'}`);
  console.log(`  claude:  ${s.claudeSessionId}`);
  if (s.detail) console.log(`  detail:  ${s.detail}`);
}

const PHASE_LABEL: Record<session.Phase, string> = {
  dead: '죽음',
  starting: '준비 중',
  working: '작업 중',
  waiting: '승인 대기',
  done: '완료, 입력 대기',
};

function printReport(r: session.Report, withTools: boolean) {
  const s = r.status;
  const tool = r.phase === 'working' && s.tool ? ` · ${s.tool}` : '';
  console.log(`${s.name}  [${s.role}]  ${PHASE_LABEL[r.phase]} (${s.state}${tool})  ${ago(s.stateAt)} 전`);
  console.log(`  tmux: ${s.alive ? '살아있음' : '없음'}  ·  claude: ${s.claudeSessionId}`);
  if (r.phase === 'waiting' && s.detail) console.log(`  대기 사유: ${s.detail}`);

  const t = r.turn;
  if (!t) return console.log('\n(아직 대화 기록 없음)');
  console.log(`\n── 지시 (${t.promptAt ?? '-'})`);
  console.log(t.prompt);
  if (withTools && t.tools.length) {
    console.log(`\n── 도구 ${t.tools.length}회`);
    for (const c of t.tools) console.log(`  ${c.name}  ${c.input}`);
  }
  const partial = !t.complete ? ' · 아직 진행 중, 부분 응답' : '';
  console.log(`\n── 응답 (${t.endedAt ?? '-'}${partial})`);
  console.log(t.texts.length ? t.texts.join('\n\n') : '(텍스트 응답 없음)');
}

async function main() {
  const argv = process.argv.slice(2);
  // '--' 뒤는 claude에 그대로 넘길 인자
  const dd = argv.indexOf('--');
  const passthrough = dd >= 0 ? argv.slice(dd + 1) : [];
  const [cmd, ...rest] = dd >= 0 ? argv.slice(0, dd) : argv;

  const { values: o, positionals: p } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      role: { type: 'string' },
      tools: { type: 'boolean' },
      prompt: { type: 'string' },
      wait: { type: 'boolean' },
      timeout: { type: 'string' },
      'no-enter': { type: 'boolean' },
      force: { type: 'boolean' },
      json: { type: 'boolean' },
      lines: { type: 'string' },
      purge: { type: 'boolean' },
      host: { type: 'string' },
      port: { type: 'string' },
    },
  });
  const timeoutMs = o.timeout ? Number(o.timeout) * 1000 : undefined;
  const need = (what = '<name>') => p[0] ?? fail(`${what} 필요`);

  switch (cmd) {
    case 'new': {
      const role = (o.role ?? 'worker') as 'worker' | 'master';
      if (role !== 'worker' && role !== 'master') fail('--role 은 worker 또는 master');
      const meta = await session.createSession({ name: need(), role, prompt: o.prompt, claudeArgs: passthrough });
      if (o.wait) {
        // 초기 프롬프트 있으면 첫 턴이 끝날 때(Stop)까지, 없으면 뜰 때(SessionStart)까지
        const st = await session.wait(meta.name, {
          timeoutMs: timeoutMs ?? (o.prompt ? undefined : 60_000),
          accept: (s) => !o.prompt || s.state !== 'idle' || s.event === 'Stop',
        });
        printStatus(st);
      } else console.log(`created ${meta.name} (tmux: ${meta.tmux}, claude: ${meta.claudeSessionId})`);
      break;
    }
    case 'ls': {
      const list = await session.listStatus();
      o.json ? console.log(JSON.stringify(list, null, 2)) : printTable(list);
      break;
    }
    case 'status': {
      const st = await session.getStatus(need());
      o.json ? console.log(JSON.stringify(st, null, 2)) : printStatus(st);
      break;
    }
    case 'send': {
      const name = need();
      const text = p[1] === '-' ? await readStdin() : p.slice(1).join(' ');
      if (!text) fail('보낼 텍스트 필요');
      const sentAt = await session.send(name, text, { submit: !o['no-enter'], force: o.force });
      if (o.wait) {
        const st = await session.wait(name, { since: sentAt, timeoutMs });
        if (st.state === 'waiting') console.error(`[${name}] 승인 대기 중: ${st.detail ?? ''}`);
        console.log(session.lastReply(name) ?? '');
      }
      break;
    }
    case 'keys':
      await session.keys(need(), ...p.slice(1));
      break;
    case 'wait': {
      const st = await session.wait(need(), { timeoutMs });
      o.json ? console.log(JSON.stringify(st, null, 2)) : printStatus(st);
      break;
    }
    case 'screen':
      process.stdout.write(await session.screen(need(), Number(o.lines ?? 0)));
      break;
    case 'last':
      console.log(session.lastReply(need()) ?? '');
      break;
    case 'report': {
      const r = await session.report(need());
      o.json ? console.log(JSON.stringify(r, null, 2)) : printReport(r, !!o.tools);
      break;
    }
    case 'attach': {
      const st = await session.getStatus(need());
      const r = spawnSync('tmux', ['attach-session', '-t', `=${st.tmux}`], { stdio: 'inherit' });
      process.exit(r.status ?? 0);
    }
    case 'kill':
      await session.kill(need(), o.purge);
      break;
    case 'serve': {
      const { serve } = await import('./server.js');
      serve({
        host: o.host ?? process.env.CARDINAL_HOST ?? '127.0.0.1',
        port: Number(o.port ?? process.env.CARDINAL_PORT ?? 7878),
        token: process.env.CARDINAL_TOKEN,
      });
      break;
    }
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      process.stdout.write(HELP);
      break;
    default:
      fail(`모르는 명령: ${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => fail(e?.message ?? String(e)));
