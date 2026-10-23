#!/usr/bin/env bash
# 카디널 설치: 필요한 도구 확인 → CLI 빌드 → 서버 의존성 → 웹 UI 빌드 → cardinal 명령 연결.
# 여러 번 돌려도 됨 (이미 된 건 다시 맞춰 줄 뿐).
#
#   ./install.sh                     # ~/.local/bin/cardinal 로 연결
#   ./install.sh --bin-dir /usr/local/bin
#   ./install.sh --no-link --no-web
set -euo pipefail

ROOT="$(cd "$(dirname "$(realpath "$0")")" && pwd)"

BIN_DIR="$HOME/.local/bin"
LINK=1
WEB=1

usage() {
  cat <<EOF
사용법: ./install.sh [옵션]

      --bin-dir DIR   cardinal 명령을 연결할 폴더 (기본 ~/.local/bin)
      --no-link       cardinal 명령 연결 안 함 (bin/cardinal 을 직접 씀)
      --no-web        웹 UI 빌드 안 함
  -h, --help          이 도움말

필요한 것: node 22+, pnpm, uv, tmux, claude (Claude Code)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bin-dir) [[ -n "${2:-}" ]] || { echo "install.sh: --bin-dir 에 값이 필요함" >&2; exit 2; }; BIN_DIR="$2"; shift 2 ;;
    --bin-dir=*) BIN_DIR="${1#*=}"; shift ;;
    --no-link) LINK=0; shift ;;
    --no-web) WEB=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: 모르는 옵션 $1" >&2; usage >&2; exit 2 ;;
  esac
done

# ---------- 도구 확인 ----------

missing=()
hint() {
  case "$1" in
    node) echo "https://nodejs.org (22 이상)" ;;
    pnpm) echo "corepack enable pnpm  또는  npm i -g pnpm" ;;
    uv) echo "curl -LsSf https://astral.sh/uv/install.sh | sh" ;;
    tmux) echo "brew install tmux  /  apt install tmux" ;;
    claude) echo "https://docs.claude.com/en/docs/claude-code" ;;
  esac
}
for cmd in node pnpm uv tmux claude; do
  command -v "$cmd" >/dev/null || missing+=("$cmd")
done
if (( ${#missing[@]} )); then
  echo "install.sh: 없는 도구가 있음" >&2
  for m in "${missing[@]}"; do echo "  - $m: $(hint "$m")" >&2; done
  exit 1
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
(( node_major >= 22 )) || { echo "install.sh: node 22 이상 필요 (지금 $(node -v))" >&2; exit 1; }

echo "✓ node $(node -v) · pnpm $(pnpm -v) · $(uv --version) · $(tmux -V) · claude $(claude --version 2>/dev/null | head -1)"

# ---------- 빌드 ----------

echo "▸ CLI 의존성 + 빌드"
(cd "$ROOT" && pnpm install --frozen-lockfile && pnpm build)

echo "▸ 서버 의존성 (uv)"
(cd "$ROOT/server" && uv sync)

if [[ $WEB == 1 ]]; then
  echo "▸ 웹 UI 의존성 + 빌드"
  (cd "$ROOT/web" && pnpm install --frozen-lockfile && pnpm build)
fi

# ---------- cardinal 명령 연결 ----------

if [[ $LINK == 1 ]]; then
  mkdir -p "$BIN_DIR"
  target="$BIN_DIR/cardinal"
  # 다른 걸 가리키는 링크는 바꾸고, 링크가 아닌 진짜 파일은 건드리지 않음
  if [[ -e "$target" && ! -L "$target" ]]; then
    echo "install.sh: $target 에 다른 파일이 있어서 연결 안 함 (지우고 다시 돌리거나 --bin-dir 로 다른 폴더)" >&2
    exit 1
  fi
  ln -sfn "$ROOT/bin/cardinal" "$target"
  echo "▸ 연결: $target → $ROOT/bin/cardinal"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "⚠ $BIN_DIR 이 PATH 에 없음. 셸 설정에 추가: export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
fi

cat <<EOF

설치 끝.
  cardinal new w1           # 세션 하나 띄우기
  ./launch.sh               # 서버 + 웹 UI (http://127.0.0.1:5173)
EOF
