#!/usr/bin/env bash
# 카디널 서버(내부, 127.0.0.1)와 웹 UI 를 같이 띄움.
# 서버는 밖에 안 열고, 웹 UI 서버(vite)가 /api, /ws 를 서버로 넘겨줌. 웹 UI 주소/포트만 인자로 바꿈.
#
#   ./launch.sh                          # 웹 UI http://127.0.0.1:5173
#   ./launch.sh --host 0.0.0.0 -p 8080   # 다른 기기에서도 접속
#   ./launch.sh --dev                    # 웹 UI 개발 모드 (코드 고치면 바로 반영)
#
# 이미 같은 포트에 카디널 서버가 떠 있으면 그걸 그대로 쓰고, 끝날 때도 안 끔.
set -euo pipefail

ROOT="$(cd "$(dirname "$(realpath "$0")")" && pwd)"

WEB_HOST=127.0.0.1
WEB_PORT=5173
SERVER_PORT="${CARDINAL_PORT:-7878}"
MODE=preview
REBUILD=0
SERVER_ARGS=()

usage() {
  cat <<EOF
사용법: ./launch.sh [옵션]

  -H, --host HOST        웹 UI 주소 (기본 127.0.0.1, 밖에서 접속하려면 0.0.0.0)
  -p, --port PORT        웹 UI 포트 (기본 5173)
      --server-port PORT 내부 카디널 서버 포트 (기본 7878 또는 CARDINAL_PORT). 서버는 항상 127.0.0.1
      --dev              웹 UI 를 개발 모드(vite dev)로
      --rebuild          CLI 와 웹 UI 를 무조건 다시 빌드하고 시작 (안 줘도 소스가 바뀌었으면 빌드함)
      --sdk              서버를 SDK 모드로 (세션을 tmux 대신 서버 안 Claude Agent SDK 로, docs/sdk-mode.md)
  -h, --help             이 도움말

환경변수: CARDINAL_HOME, CARDINAL_TOKEN, DISCORD_TOKEN, SLACK_BOT_TOKEN, SLACK_APP_TOKEN 등은 서버에 그대로 넘어감.
CARDINAL_WEB_HOSTS=a.example,b.example 이면 웹 UI 를 그 이름으로도 열 수 있음 (vite allowedHosts).
EOF
}

need_value() { [[ $# -ge 2 && -n "$2" ]] || { echo "launch.sh: $1 에 값이 필요함" >&2; exit 2; }; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    -H|--host) need_value "$@"; WEB_HOST="$2"; shift 2 ;;
    -p|--port) need_value "$@"; WEB_PORT="$2"; shift 2 ;;
    --server-port) need_value "$@"; SERVER_PORT="$2"; shift 2 ;;
    --host=*) WEB_HOST="${1#*=}"; shift ;;
    --port=*) WEB_PORT="${1#*=}"; shift ;;
    --server-port=*) SERVER_PORT="${1#*=}"; shift ;;
    --dev) MODE=dev; shift ;;
    --rebuild) REBUILD=1; shift ;;
    --sdk) SERVER_ARGS+=(--sdk); shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "launch.sh: 모르는 옵션 $1" >&2; usage >&2; exit 2 ;;
  esac
done

for p in "$WEB_PORT" "$SERVER_PORT"; do
  [[ "$p" =~ ^[0-9]+$ ]] && (( p > 0 && p < 65536 )) || { echo "launch.sh: 잘못된 포트 $p" >&2; exit 2; }
done
[[ "$WEB_PORT" != "$SERVER_PORT" ]] || { echo "launch.sh: 웹 UI 포트와 서버 포트가 같음 ($WEB_PORT)" >&2; exit 2; }

for cmd in node pnpm uv curl; do
  command -v "$cmd" >/dev/null || { echo "launch.sh: $cmd 이 없음" >&2; exit 1; }
done

# ---------- 빌드 (없거나 소스가 빌드보다 새로우면, --rebuild 면 항상) ----------

# stale <결과 파일> <소스…>: 결과가 없거나 소스 중 하나라도 더 새로우면 참
stale() {
  local out="$1"; shift
  [[ ! -e "$out" ]] && return 0
  [[ -n "$(find "$@" -newer "$out" -print -quit 2>/dev/null)" ]]
}

# build <이름> <폴더> <결과 파일>: 결과가 이미 있으면 빌드가 실패해도 예전 빌드로 계속 (launchd 가 재시작만 반복하지 않게)
build() {
  echo "▸ $1 빌드"
  (cd "$2" && pnpm build) && return 0
  [[ -e "$3" ]] || { echo "launch.sh: $1 빌드 실패" >&2; exit 1; }
  echo "⚠ $1 빌드 실패 → 예전 빌드로 시작 (고친 뒤 다시 실행하면 다시 빌드)" >&2
}

# 의존성: 없거나 package.json·lockfile 이 바뀌었으면 (git pull 로 의존성이 늘었을 때)
if stale "$ROOT/node_modules/.modules.yaml" "$ROOT/package.json" "$ROOT/pnpm-lock.yaml"; then
  echo "▸ CLI 의존성 설치"
  (cd "$ROOT" && pnpm install --frozen-lockfile)
fi
if [[ $REBUILD == 1 ]] || stale "$ROOT/dist/cli.js" "$ROOT/src" "$ROOT/package.json" "$ROOT/tsconfig.json"; then
  build CLI "$ROOT" "$ROOT/dist/cli.js"
fi
if stale "$ROOT/web/node_modules/.modules.yaml" "$ROOT/web/package.json" "$ROOT/web/pnpm-lock.yaml"; then
  echo "▸ 웹 UI 의존성 설치"
  (cd "$ROOT/web" && pnpm install --frozen-lockfile)
fi
if [[ $MODE == preview ]] && { [[ $REBUILD == 1 ]] || stale "$ROOT/web/dist/index.html" \
  "$ROOT/web/src" "$ROOT/web/public" "$ROOT/web/index.html" "$ROOT/web/vite.config.ts" "$ROOT/web/tsconfig.json" "$ROOT/web/package.json"; }; then
  build "웹 UI" "$ROOT/web" "$ROOT/web/dist/index.html"
fi

# ---------- 카디널 서버 ----------

SERVER_URL="http://127.0.0.1:$SERVER_PORT"
SERVER_PID=
WEB_PID=

# 토큰을 걸고 띄운 서버는 401 을 주지만 떠 있는 건 맞음
up() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 2 "$SERVER_URL/api/health" 2>/dev/null)" || true
  [[ $code == 200 || $code == 401 ]]
}

cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$WEB_PID" ]] && kill -0 "$WEB_PID" 2>/dev/null; then
    kill -TERM "$WEB_PID" 2>/dev/null || true
    wait "$WEB_PID" 2>/dev/null || true
  fi
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "▸ 카디널 서버 종료"
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if up; then
  echo "▸ 이미 떠 있는 카디널 서버 사용: $SERVER_URL (끝날 때 안 끔)"
  if (( ${#SERVER_ARGS[@]} )) && ! curl -s -m 2 "$SERVER_URL/api/health" | grep -q '"enabled":true'; then
    echo "⚠ 떠 있는 서버는 SDK 모드가 아님 (--sdk 는 서버를 새로 띄울 때만 적용). 그 서버를 끄고 다시 실행하세요."
  fi
else
  echo "▸ 카디널 서버 시작: $SERVER_URL"
  # uv run 을 거치면 pid 가 uv 라서, 의존성만 맞추고 서버를 직접 띄움 (종료 신호가 서버에 바로 가게)
  (cd "$ROOT/server" && uv sync -q)
  "$ROOT/server/.venv/bin/cardinal-server" --host 127.0.0.1 --port "$SERVER_PORT" ${SERVER_ARGS[@]+"${SERVER_ARGS[@]}"} &
  SERVER_PID=$!
  for _ in $(seq 1 60); do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      wait "$SERVER_PID" 2>/dev/null || true
      SERVER_PID=
WEB_PID=
      echo "launch.sh: 카디널 서버가 시작 못 함 (위 로그 참고)" >&2
      exit 1
    fi
    up && break
    sleep 0.5
  done
  up || { echo "launch.sh: 카디널 서버가 30초 안에 응답 안 함" >&2; exit 1; }
fi

# ---------- 웹 UI ----------

case "$WEB_HOST" in
  127.*|localhost|::1) ;;
  *)
    if [[ -z "${CARDINAL_TOKEN:-}" ]]; then
      echo "⚠ 웹 UI 를 $WEB_HOST 로 엽니다. 같은 네트워크의 누구나 세션을 조작할 수 있음."
      echo "  막으려면 CARDINAL_TOKEN=<비밀값> ./launch.sh … 로 띄우세요."
    fi
    ;;
esac

echo "▸ 웹 UI ($MODE): http://$WEB_HOST:$WEB_PORT  →  $SERVER_URL"
cd "$ROOT/web"
# 백그라운드로 띄우고 wait: 포그라운드면 vite 가 끝날 때까지 trap 이 안 돌아서 kill 로는 안 꺼짐.
# pnpm exec 를 거치면 pid 가 pnpm 이라 .bin/vite 를 직접 (pnpm 의 bin 은 exec node … 라 pid 가 vite)
CARDINAL_URL="$SERVER_URL" ./node_modules/.bin/vite "$([[ $MODE == dev ]] && echo serve || echo preview)" \
  --host "$WEB_HOST" --port "$WEB_PORT" --strictPort &
WEB_PID=$!
# 둘 중 하나라도 죽으면 같이 끝냄
while kill -0 "$WEB_PID" 2>/dev/null; do
  if [[ -n "$SERVER_PID" ]] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "launch.sh: 카디널 서버가 꺼짐" >&2
    exit 1
  fi
  sleep 1 & wait $!
done
wait "$WEB_PID"
