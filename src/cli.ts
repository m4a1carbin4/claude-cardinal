import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { reply } from './reply.js';
import * as session from './session.js';
import type { SessionStatus } from './session.js';

const HELP = `cardinal — tmux + Claude Code 세션 제어

  cardinal new <name> [--role worker|master] [--cwd DIR] [--trust] [--prompt TEXT] [--wait] [-- <claude 인자...>]
                                             --cwd: 작업 폴더 (기본 $CARDINAL_WORKSPACE). 처음 쓰는 폴더는 신뢰 다이얼로그가 뜸
                                             --trust: 그 다이얼로그를 자동으로 수락
  cardinal ls [--json]                       세션 목록 + 상태
  cardinal status <name> [--json]            한 세션 상태
  cardinal send <name> <text|-> [--wait] [--timeout SEC] [--now] [--queue-timeout SEC] [--no-enter] [--force]
                                             메시지 보내기 ('-' 면 stdin), --wait 면 그 턴이 끝날 때까지 기다리고 그 턴의 응답 출력
                                             같은 세션 send 는 한 줄로 섬. 작업 중이면 idle 될 때까지 기다렸다가 보냄
                                             (--now: 안 기다리고 진행 중인 턴에 끼워넣기, --queue-timeout: 대기 한도, 기본 600초)
  cardinal keys <name> <key...>              tmux 키 그대로 전송 (예: Enter, Escape, C-c, 1)
  cardinal wait <name> [--timeout SEC]       idle/waiting/ended 될 때까지 대기
  cardinal screen <name> [--lines N]         현재 화면 (N 주면 스크롤백 포함)
  cardinal report <name> [--tools] [--json]  결과 보고: 살아있는지, 작업중/완료, 마지막 턴 응답 전체
  cardinal last <name>                       마지막 턴 응답 텍스트만
  cardinal attach <name>                     tmux에 직접 붙기
  cardinal kill <name> [--purge]             세션 종료 (--purge 면 기록도 삭제)
  cardinal reply <event-id> <text|-> [--file PATH]...
                                             외부 채널 이벤트에 답장 (카디널 서버 필요). 파일은 최대 10개, 각 10MB

new/send/kill 은 --json 주면 결과를 JSON으로 출력.
서버(웹소켓, 디스코드 채널, DB)는 server/ 의 Python 서비스로 분리됨.

상태: starting → idle ⇄ busy, waiting(승인 대기), ended
세션 작업 폴더: 기본은 $CARDINAL_WORKSPACE (기본 ~/.cardinal/workspace), --cwd 로 세션별 지정.
기록(meta/훅)은 작업 폴더와 상관없이 항상 $CARDINAL_HOME (기본 ~/.cardinal) 아래.
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
  interrupted: '사람이 중단함 (입력 대기)',
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
  const partial = t.interrupted ? ' · 사람이 중단함, 부분 응답' : !t.complete ? ' · 아직 진행 중, 부분 응답' : '';
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
      cwd: { type: 'string' },
      trust: { type: 'boolean' },
      wait: { type: 'boolean' },
      timeout: { type: 'string' },
      'no-enter': { type: 'boolean' },
      now: { type: 'boolean' },
      'queue-timeout': { type: 'string' },
      force: { type: 'boolean' },
      json: { type: 'boolean' },
      lines: { type: 'string' },
      purge: { type: 'boolean' },
      file: { type: 'string', multiple: true },
    },
  });
  const timeoutMs = o.timeout ? Number(o.timeout) * 1000 : undefined;
  const need = (what = '<name>') => p[0] ?? fail(`${what} 필요`);

  switch (cmd) {
    case 'new': {
      const role = (o.role ?? 'worker') as 'worker' | 'master';
      if (role !== 'worker' && role !== 'master') fail('--role 은 worker 또는 master');
      const meta = await session.createSession({
        name: need(),
        role,
        prompt: o.prompt,
        claudeArgs: passthrough,
        cwd: o.cwd,
        trust: o.trust,
      });
      if (o.wait) {
        // 초기 프롬프트 있으면 첫 턴이 끝날 때(Stop)까지, 없으면 뜰 때(SessionStart)까지
        const st = await session.wait(meta.name, {
          timeoutMs: timeoutMs ?? (o.prompt ? undefined : 60_000),
          accept: (s) => !o.prompt || s.state !== 'idle' || s.event === 'Stop',
        });
        o.json ? console.log(JSON.stringify(st, null, 2)) : printStatus(st);
        // 신뢰 다이얼로그에서 멈춤: 기다려도 안 풀리니 바로 알려주고 실패로
        if (st.trustPrompt) fail(`${meta.name}: 작업 폴더 신뢰 다이얼로그 대기 중. cardinal keys ${meta.name} Down Enter 로 넘기거나 다음부터 --trust`);
      } else if (o.json) console.log(JSON.stringify(await session.getStatus(meta.name), null, 2));
      else console.log(`created ${meta.name} (tmux: ${meta.tmux}, claude: ${meta.claudeSessionId})`);
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
      const res = await session.send(name, text, {
        submit: !o['no-enter'],
        force: o.force,
        now: o.now,
        queueTimeoutMs: o['queue-timeout'] ? Number(o['queue-timeout']) * 1000 : undefined,
      });
      const notAccepted = !res.accepted && !o['no-enter'];
      if (notAccepted && o.wait) {
        // 안 들어간 메시지의 턴을 기다려봐야 안 끝남 (예전엔 여기서 --timeout 까지 멈췄음)
        if (o.json) console.log(JSON.stringify({ sentAt: res.sentAt, accepted: false, timedOut: false, last: null }));
        fail(`[${name}] Enter 를 ${3}번 눌렀지만 claude가 받았다는 신호가 없음. 입력창에 텍스트가 남아 있을 수 있음 (cardinal screen 으로 확인)`);
      }
      if (notAccepted) console.error(`[${name}] 보냈지만 claude가 받았다는 신호를 못 봄`);
      if (o.wait) {
        // 대기 시간 초과는 전달 실패가 아님 (메시지는 이미 들어감). 그때까지의 부분 응답과 함께 timedOut 으로 알려줌
        let st: SessionStatus;
        let timedOut = false;
        try {
          st = await session.wait(name, { since: res.sentAt, timeoutMs });
        } catch (e: any) {
          if (!e?.status) throw e;
          st = e.status;
          timedOut = true;
        }
        const turn = timedOut ? session.turnOf(name, res) : await session.settledTurnOf(name, res, st);
        const last = session.turnText(turn);
        // 사람이 Esc 로 중단: 그 턴은 사람 손으로 넘어간 거라 실패도 완료도 아님. 지금까지의 응답만 돌려줌
        const interrupted = !timedOut && (st.event === 'Interrupted' || !!turn?.interrupted);
        if (o.json) {
          console.log(JSON.stringify({ sentAt: res.sentAt, accepted: res.accepted, timedOut, interrupted, status: st, last: last ?? null }, null, 2));
        } else {
          if (st.state === 'waiting') console.error(`[${name}] 승인 대기 중: ${st.detail ?? ''}`);
          if (interrupted) console.error(`[${name}] 사람이 중단함 (Esc). 아래는 중단 전까지의 응답`);
          console.log(last ?? '');
          // 텍스트 모드는 스크립트가 알아챌 수 있게 종료 코드로
          if (timedOut) fail(`대기 시간 초과: ${name} (${st.state}). 메시지는 들어갔고 위는 지금까지의 부분 응답`);
        }
      } else if (o.json) console.log(JSON.stringify({ sentAt: res.sentAt, accepted: res.accepted }));
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
      if (o.json) console.log(JSON.stringify({ ok: true }));
      break;
    case 'reply': {
      const eventId = need('<event-id>');
      const text = p[1] === '-' ? await readStdin() : p.slice(1).join(' ');
      const r = await reply(eventId, text, o.file ?? []);
      console.log(o.json ? JSON.stringify(r, null, 2) : `sent reply to ${eventId}`);
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
