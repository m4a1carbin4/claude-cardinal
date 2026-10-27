#!/usr/bin/env bash
# macOS 로그인(재부팅 후 포함) 때 카디널 서버 + 웹 UI 를 알아서 띄우게 launchd 에 등록.
# 실제로 띄우는 건 launch.sh 라서 옵션은 launch.sh 것을 그대로 넘김. 기본은 127.0.0.1 에만 열림.
#
#   ./autostart.sh install --sdk            # 등록하고 바로 시작 (이미 등록돼 있으면 새 옵션으로 다시)
#   ./autostart.sh install --sdk -p 5180    # 웹 UI 포트 바꾸기
#   ./autostart.sh status
#   ./autostart.sh uninstall                # 끄고 등록 해제
#
# plist 에는 이 컴퓨터의 경로(node, uv, tmux, claude 위치)가 들어가서 저장소에 안 두고 여기서 만들어 씀.
set -euo pipefail

ROOT="$(cd "$(dirname "$(realpath "$0")")" && pwd)"
LABEL="${CARDINAL_LAUNCHD_LABEL:-claude-cardinal}" # 저장소 이름과 같게
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
LOG_DIR="${CARDINAL_HOME:-$HOME/.cardinal}/logs"

usage() {
  cat <<EOF
사용법: ./autostart.sh <install [launch.sh 옵션…] | uninstall | status>

  install     $PLIST 를 만들고 등록 + 바로 시작. 로그인할 때마다 시작, 꺼지면 다시 띄움
  uninstall   끄고 plist 지움
  status      등록/실행 상태

로그: $LOG_DIR/launchd.log
환경변수: CARDINAL_HOME, CARDINAL_PORT, CARDINAL_TOKEN, CARDINAL_WEB_HOSTS, DISCORD_TOKEN 이 설정돼 있으면 plist 에 그대로 들어감.
EOF
}

[[ "$(uname)" == Darwin ]] || { echo "autostart.sh: macOS(launchd) 전용" >&2; exit 1; }

xml() { local s="$1"; s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"; printf '%s' "$s"; }

loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

# launchd 는 셸 설정을 안 읽어서 PATH 가 /usr/bin:/bin 정도뿐. 지금 셸에서 찾은 도구 위치를 넣어 둠
build_path() {
  local dirs=() d cmd seen=":"
  for cmd in node pnpm uv tmux claude curl; do
    command -v "$cmd" >/dev/null || { echo "autostart.sh: $cmd 이 없음 (./install.sh 먼저)" >&2; exit 1; }
    dirs+=("$(dirname "$(command -v "$cmd")")")
  done
  dirs+=(/opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin)
  local out=""
  for d in "${dirs[@]}"; do
    [[ $seen == *":$d:"* ]] && continue
    seen+="$d:"
    out+="${out:+:}$d"
  done
  printf '%s' "$out"
}

install() {
  local args=("$@") a env_xml="" name
  mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"

  env_xml+="    <key>PATH</key><string>$(xml "$(build_path)")</string>"$'\n'
  env_xml+="    <key>LANG</key><string>$(xml "${LANG:-en_US.UTF-8}")</string>"$'\n'
  for name in CARDINAL_HOME CARDINAL_PORT CARDINAL_TOKEN CARDINAL_WEB_HOSTS DISCORD_TOKEN; do
    [[ -n "${!name:-}" ]] && env_xml+="    <key>$name</key><string>$(xml "${!name}")</string>"$'\n'
  done

  local args_xml="    <string>/bin/bash</string>"$'\n'"    <string>$(xml "$ROOT/launch.sh")</string>"$'\n'
  for a in ${args[@]+"${args[@]}"}; do
    args_xml+="    <string>$(xml "$a")</string>"$'\n'
  done

  local tmp
  tmp="$(mktemp)"
  cat >"$tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(xml "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
${args_xml}  </array>
  <key>WorkingDirectory</key><string>$(xml "$ROOT")</string>
  <key>EnvironmentVariables</key>
  <dict>
${env_xml}  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <!-- launch.sh 가 SIGTERM 받으면 서버(SDK 세션 정리 포함)와 웹 UI 를 직접 끔. 시간 넉넉히 -->
  <key>ExitTimeOut</key><integer>30</integer>
  <!-- 세션용 tmux 서버는 따로 떨어져 나간 프로세스라 launchd 가 같이 죽이지 않게 -->
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>$(xml "$LOG_DIR/launchd.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG_DIR/launchd.log")</string>
</dict>
</plist>
EOF
  plutil -lint -s "$tmp" || { rm -f "$tmp"; echo "autostart.sh: plist 생성 실패" >&2; exit 1; }

  if loaded; then
    echo "▸ 이미 등록됨 → 끄고 다시 등록"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    # 서버가 다 꺼질 때까지 (안 그러면 새 서버가 중복 실행 확인에 걸림)
    for _ in $(seq 1 40); do loaded || break; sleep 0.5; done
  fi
  mv "$tmp" "$PLIST"
  chmod 600 "$PLIST" # 토큰이 들어갈 수 있음
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "✓ 등록: $PLIST"
  echo "  로그: $LOG_DIR/launchd.log"
  echo "  끄기: ./autostart.sh uninstall"
}

uninstall() {
  if loaded; then
    launchctl bootout "$DOMAIN/$LABEL" || true
    for _ in $(seq 1 40); do loaded || break; sleep 0.5; done
    echo "✓ 껐음"
  fi
  if [[ -f "$PLIST" ]]; then
    rm -f "$PLIST"
    echo "✓ 지움: $PLIST"
  else
    echo "등록된 plist 없음"
  fi
}

status() {
  if [[ ! -f "$PLIST" ]]; then echo "등록 안 됨"; return; fi
  echo "plist: $PLIST"
  if loaded; then
    launchctl print "$DOMAIN/$LABEL" | grep -E $'^\t(state|pid|last exit code|runs) =' || true
  else
    echo "plist 는 있지만 launchd 에 안 올라가 있음 (다음 로그인 때 시작)"
  fi
  echo "로그: $LOG_DIR/launchd.log"
}

case "${1:-}" in
  install) shift; install "$@" ;;
  uninstall) uninstall ;;
  status) status ;;
  -h|--help|"") usage ;;
  *) echo "autostart.sh: 모르는 명령 $1" >&2; usage >&2; exit 2 ;;
esac
