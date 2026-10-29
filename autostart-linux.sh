#!/usr/bin/env bash
# Linux 에서 재부팅(로그인) 때 카디널 서버 + 웹 UI 를 알아서 띄우게 등록. macOS 의 autostart.sh(launchd) 와 같은 일.
# Linux 에서 ./autostart.sh 를 부르면 이 스크립트로 넘어옴. 실제로 띄우는 건 launch.sh 라서 옵션은 launch.sh 것을 그대로 넘김.
#
# 방식 세 가지 (안 고르면 되는 것 중 위에서부터):
#   --user    systemd 사용자 서비스 (systemctl --user). sudo 필요 없음. 부팅 때 바로 뜨려면 linger
#   --system  systemd 시스템 서비스 (sudo systemctl). 사용자 세션이 없는 서버·ssh·WSL 에서
#   --cron    systemd 가 없을 때. crontab @reboot 로 띄우고 꺼지면 10초 뒤 다시 띄우는 루프
#
#   ./autostart-linux.sh install --sdk                 # 알아서 고름
#   ./autostart-linux.sh install --system --sdk -p 5180
#   ./autostart-linux.sh status
#   ./autostart-linux.sh print --system --sdk          # 만들 파일만 보여줌 (등록 안 함, 토큰은 가림. 어느 OS 에서든 됨)
#   ./autostart-linux.sh uninstall                     # 등록된 방식 찾아서 끄고 지움
#
# 유닛에는 이 컴퓨터의 경로(node, uv, tmux, claude 위치)가 들어가서 저장소에 안 두고 여기서 만들어 씀.
set -euo pipefail

ROOT="$(cd "$(dirname "$(realpath "$0")")" && pwd)"
NAME="${CARDINAL_SERVICE_NAME:-claude-cardinal}" # 저장소 이름과 같게
CONF="${XDG_CONFIG_HOME:-$HOME/.config}"
USER_UNIT="$CONF/systemd/user/$NAME.service"
SYSTEM_UNIT="/etc/systemd/system/$NAME.service"
ENV_FILE="$CONF/$NAME/$NAME.env" # 토큰이 들어갈 수 있어서 유닛과 따로, 권한 600 (세 방식 다 이걸 읽음)
STATE_DIR="${CARDINAL_HOME:-$HOME/.cardinal}"
LOG_DIR="$STATE_DIR/logs"
LOG="$LOG_DIR/autostart.log"
PID_FILE="$STATE_DIR/autostart.pid" # cron 방식의 다시 띄우기 루프
CRON_TAG="# $NAME autostart"
PASS_ENV=(CARDINAL_HOME CARDINAL_PORT CARDINAL_TOKEN CARDINAL_WEB_HOSTS DISCORD_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN)

usage() {
  cat <<EOF
사용법: ./autostart-linux.sh <명령>

  install [--user|--system|--cron] [launch.sh 옵션…]
              등록하고 바로 시작. 이미 등록돼 있으면 (다른 방식이어도) 끄고 새 설정으로 다시
  uninstall   등록된 방식 찾아서 끄고 지움 (세션용 tmux 는 그대로)
  status      등록/실행 상태
  print [--user|--system|--cron] [launch.sh 옵션…]
              만들 파일을 보여주기만 함 (토큰 값은 가림)

방식 (안 고르면 되는 것 중 위에서부터):
  --user      systemd 사용자 서비스  $USER_UNIT
  --system    systemd 시스템 서비스  $SYSTEM_UNIT (sudo)
  --cron      crontab @reboot + 다시 띄우기 루프 (systemd 없을 때)

환경: $ENV_FILE (600)
로그: $LOG
환경변수: ${PASS_ENV[*]} 이 설정돼 있으면 환경 파일에 그대로 들어감.
EOF
}

# ---------- 글자 이스케이프 ----------

# systemd 유닛 안의 글자: % 는 지정자, $ 는 변수라 두 번 씀
unit_esc() { local s="$1"; s="${s//%/%%}"; s="${s//\$/\$\$}"; printf '%s' "$s"; }
# ExecStart 인자 하나: 큰따옴표로 감싸고 \ 와 " 를 이스케이프
unit_arg() { local s; s="$(unit_esc "$1")"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; printf '"%s"' "$s"; }
# 환경 파일 값: 큰따옴표 안에서 \ " $ ` 이스케이프. systemd EnvironmentFile 과 sh 의 . (cron 방식) 둘 다 읽을 수 있음
env_val() { local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//\$/\\\$}"; s="${s//\`/\\\`}"; printf '"%s"' "$s"; }
# crontab 한 줄 인자: sh 용 작은따옴표, % 는 crontab 에서 줄바꿈이라 \%
cron_arg() { local s="$1" q="'\\''"; s="${s//\'/$q}"; s="'$s'"; printf '%s' "${s//%/\\%}"; }

# ---------- 만들 파일 ----------

# 서비스는 셸 설정을 안 읽어서 PATH 가 짧음. 지금 셸에서 찾은 도구 위치를 넣어 둠
build_path() {
  local dirs=() d cmd seen=":"
  for cmd in node pnpm uv tmux claude curl; do
    command -v "$cmd" >/dev/null || { echo "autostart-linux.sh: $cmd 이 없음 (./install.sh 먼저)" >&2; exit 1; }
    dirs+=("$(dirname "$(command -v "$cmd")")")
  done
  dirs+=("$HOME/.local/bin" /usr/local/bin /usr/bin /bin /usr/local/sbin /usr/sbin /sbin)
  local out=""
  for d in "${dirs[@]}"; do
    [[ $seen == *":$d:"* ]] && continue
    seen+="$d:"
    out+="${out:+:}$d"
  done
  printf '%s' "$out"
}

# render_env [mask]: 환경 파일 내용. mask 면 비밀일 수 있는 값을 가림
render_env() {
  local mask="${1:-}" name
  echo "# $NAME 자동 시작 환경 (autostart-linux.sh 가 만듦, 다시 install 하면 덮어씀)"
  echo "PATH=$(env_val "$(build_path)")"
  echo "LANG=$(env_val "${LANG:-C.UTF-8}")"
  echo "HOME=$(env_val "$HOME")" # 시스템 서비스·cron 에서도 같은 ~/.cardinal, ~/.claude 를 보게
  for name in "${PASS_ENV[@]}"; do
    [[ -n "${!name:-}" ]] || continue
    case "$name" in
      *TOKEN) [[ -n $mask ]] && { echo "$name=\"***\""; continue; } ;;
    esac
    echo "$name=$(env_val "${!name}")"
  done
}

# render_unit <user|system> [launch.sh 옵션…]
render_unit() {
  local mode="$1" a exec; shift
  exec="$(unit_arg "$(command -v bash)") $(unit_arg "$ROOT/launch.sh")"
  for a in "$@"; do exec+=" $(unit_arg "$a")"; done
  echo "# autostart-linux.sh 가 만듦. 고치려면 ./autostart-linux.sh install --$mode … 로 다시"
  echo "[Unit]"
  echo "Description=Claude Cardinal (server + web UI)"
  [[ $mode == system ]] && echo "Wants=network-online.target"
  echo "After=network-online.target"
  echo
  echo "[Service]"
  echo "Type=simple"
  if [[ $mode == system ]]; then
    # 시스템 서비스지만 이 사용자로 돌림 (세션·tmux·claude 로그인이 다 이 사용자 것)
    echo "User=$(id -un)"
    echo "Group=$(id -gn)"
  fi
  cat <<EOF
WorkingDirectory=$(unit_esc "$ROOT")
EnvironmentFile=$(unit_esc "$ENV_FILE")
ExecStart=$exec
Restart=always
RestartSec=10
# launch.sh 가 SIGTERM 받으면 서버(SDK 세션 정리 포함)와 웹 UI 를 직접 끔. 시간 넉넉히
TimeoutStopSec=30
# 신호는 launch.sh 에만. 기본(control-group)이면 세션용 tmux 서버까지 같이 죽어서 다시 시작할 때마다 세션이 꺼짐
KillMode=process
StandardOutput=append:$(unit_esc "$LOG")
StandardError=append:$(unit_esc "$LOG")

[Install]
WantedBy=$([[ $mode == system ]] && echo multi-user.target || echo default.target)
EOF
}

render_cron() {
  local line a
  line="@reboot $(cron_arg "$(command -v bash)") $(cron_arg "$ROOT/autostart-linux.sh") run"
  for a in "$@"; do line+=" $(cron_arg "$a")"; done
  printf '%s >> %s 2>&1 %s\n' "$line" "$(cron_arg "$LOG")" "$CRON_TAG"
}

# ---------- 방식별 확인 ----------

has_systemctl() { command -v systemctl >/dev/null; }
user_ok() { has_systemctl && systemctl --user show-environment >/dev/null 2>&1; }
# PID 1 이 systemd 인지 (컨테이너·systemd 없는 WSL 이면 systemctl 이 있어도 못 씀)
system_ok() { has_systemctl && [[ -d /run/systemd/system ]]; }
cron_ok() { command -v crontab >/dev/null; }
cron_line() { crontab -l 2>/dev/null | grep -F "$CRON_TAG" || true; }
linger() { [[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" == yes ]]; }

# 지금 등록된 방식 (없으면 빈 글자)
installed_mode() {
  if [[ -f "$USER_UNIT" ]]; then echo user
  elif [[ -f "$SYSTEM_UNIT" ]]; then echo system
  elif cron_ok && [[ -n "$(cron_line)" ]]; then echo cron
  fi
}

pick_mode() {
  if user_ok; then echo user
  elif system_ok; then echo system
  elif cron_ok; then echo cron
  else
    echo "autostart-linux.sh: systemd 도 crontab 도 못 씀. 직접 launch.sh 를 시작 스크립트에 넣어야 함" >&2
    exit 1
  fi
}

check_mode() {
  case "$1" in
    user) user_ok || { echo "autostart-linux.sh: systemd 사용자 세션에 못 붙음 (systemctl --user). --system 이나 --cron 을 쓰거나, WSL 이면 /etc/wsl.conf 에 [boot] systemd=true" >&2; exit 1; } ;;
    system) system_ok || { echo "autostart-linux.sh: systemd 가 PID 1 이 아님 (컨테이너·WSL?). --cron 을 쓰세요" >&2; exit 1; } ;;
    cron) cron_ok || { echo "autostart-linux.sh: crontab 이 없음 (cron 패키지 설치 필요)" >&2; exit 1; } ;;
  esac
}

# ---------- cron 방식 루프 ----------

# 루프 pid. 재부팅 뒤엔 pid 파일이 남아 있고 그 번호를 다른 프로세스가 쓸 수 있어서 명령까지 확인
loop_pid() {
  local pid
  [[ -f "$PID_FILE" ]] || return 1
  pid="$(cat "$PID_FILE")"
  ps -o args= -p "$pid" 2>/dev/null | grep -q "autostart-linux.sh run" || return 1
  echo "$pid"
}

stop_loop() {
  local pid
  pid="$(loop_pid)" || return 0
  kill -TERM "$pid" 2>/dev/null || true
  # launch.sh 가 서버를 다 끌 때까지 (안 그러면 새 서버가 중복 실행 확인에 걸림)
  for _ in $(seq 1 70); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  rm -f "$PID_FILE"
}

# run [launch.sh 옵션…]: cron 이 부르는 것. launch.sh 를 띄우고 꺼지면 10초 뒤 다시 (systemd 의 Restart=always 대신)
run() {
  local pid
  if pid="$(loop_pid)"; then echo "autostart-linux.sh: 이미 돌고 있음 (pid $pid)" >&2; exit 0; fi
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  cd "$ROOT"
  echo $$ >"$PID_FILE"
  local child=""
  stop_child() {
    if [[ -n $child ]]; then
      kill -TERM "$child" 2>/dev/null || true
      wait "$child" 2>/dev/null || true # launch.sh 가 서버·웹 UI 를 다 끌 때까지
    fi
    rm -f "$PID_FILE"
    exit 0
  }
  trap stop_child TERM INT
  while true; do
    echo "▸ $(date '+%F %T') launch.sh 시작"
    bash "$ROOT/launch.sh" "$@" &
    child=$!
    wait "$child" || true
    child=""
    echo "▸ $(date '+%F %T') launch.sh 끝남 → 10초 뒤 다시"
    sleep 10 &
    wait $!
  done
}

# ---------- 명령 ----------

write_env() {
  local tmp
  mkdir -p "$(dirname "$ENV_FILE")" "$LOG_DIR"
  tmp="$(mktemp)"
  render_env >"$tmp"
  command install -m 600 "$tmp" "$ENV_FILE"
  rm -f "$tmp"
  # 시스템 서비스면 systemd(root)가 로그 파일을 만들어 root 것이 되니까 미리 이 사용자로 만들어 둠
  touch "$LOG"
}

remove() {
  local mode="$1"
  case "$mode" in
    user)
      systemctl --user disable --now "$NAME.service" 2>/dev/null || true
      rm -f "$USER_UNIT"
      systemctl --user daemon-reload 2>/dev/null || true
      ;;
    system)
      sudo systemctl disable --now "$NAME.service" 2>/dev/null || true
      sudo rm -f "$SYSTEM_UNIT"
      sudo systemctl daemon-reload || true
      ;;
    cron)
      { crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true; } | crontab -
      stop_loop
      ;;
  esac
}

do_install() {
  local mode=""
  case "${1:-}" in --user|--system|--cron) mode="${1#--}"; shift ;; esac
  [[ -n $mode ]] || mode="$(pick_mode)"
  check_mode "$mode"
  echo "▸ 방식: $mode"

  # 이미 등록돼 있으면 (방식이 달라도) 끄고 지운 뒤 새로. 서버가 다 꺼질 때까지 기다림
  local old
  old="$(installed_mode)"
  if [[ -n $old ]]; then
    echo "▸ 이미 등록됨 ($old) → 끄고 새 설정으로 다시"
    remove "$old"
  fi
  write_env

  local tmp
  tmp="$(mktemp)"
  case "$mode" in
    user)
      render_unit user "$@" >"$tmp"
      mkdir -p "$(dirname "$USER_UNIT")"
      command install -m 644 "$tmp" "$USER_UNIT"
      systemctl --user daemon-reload
      systemctl --user enable --now --quiet "$NAME.service"
      echo "✓ 등록: $USER_UNIT"
      echo "  다시 시작: systemctl --user restart $NAME"
      # linger 가 꺼져 있으면 로그인해야 시작되고, 로그아웃하면 같이 꺼짐
      if ! linger; then
        if loginctl enable-linger "$(id -un)" 2>/dev/null && linger; then
          echo "✓ linger 켬: 로그인 안 해도 부팅 때 시작"
        else
          echo "⚠ linger 가 꺼져 있음: 로그인해야 시작되고 로그아웃하면 꺼짐. 부팅 때 바로 띄우려면:"
          echo "    sudo loginctl enable-linger $(id -un)"
        fi
      fi
      ;;
    system)
      render_unit system "$@" >"$tmp"
      echo "▸ sudo 로 $SYSTEM_UNIT 설치"
      sudo install -m 644 "$tmp" "$SYSTEM_UNIT"
      sudo systemctl daemon-reload
      sudo systemctl enable --now --quiet "$NAME.service"
      echo "✓ 등록: $SYSTEM_UNIT (User=$(id -un))"
      echo "  다시 시작: sudo systemctl restart $NAME"
      ;;
    cron)
      { crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true; render_cron "$@"; } | crontab -
      # 지금도 바로 띄움 (터미널과 떨어지게 setsid)
      setsid bash "$ROOT/autostart-linux.sh" run "$@" >>"$LOG" 2>&1 </dev/null &
      echo "✓ 등록: crontab @reboot ($CRON_TAG)"
      echo "  다시 시작: ./autostart-linux.sh install --cron … 를 다시 (꺼지면 10초 뒤 알아서 다시 뜸)"
      ;;
  esac
  rm -f "$tmp"
  echo "  환경: $ENV_FILE (600)"
  echo "  로그: $LOG"
  echo "  끄기: ./autostart-linux.sh uninstall"
}

uninstall() {
  local mode
  mode="$(installed_mode)"
  if [[ -z $mode ]]; then
    echo "등록된 것 없음"
  else
    remove "$mode"
    echo "✓ 껐고 지움 ($mode)"
  fi
  rm -f "$ENV_FILE"
  rmdir "$(dirname "$ENV_FILE")" 2>/dev/null || true
}

status() {
  local mode pid
  mode="$(installed_mode)"
  case "$mode" in
    "") echo "등록 안 됨" ;;
    user)
      echo "방식: systemd 사용자 서비스 ($USER_UNIT)"
      systemctl --user status "$NAME.service" --no-pager --lines=0 2>/dev/null | sed -n '1,5p' || true
      echo "linger: $(linger && echo 켜짐 || echo '꺼짐 (로그인해야 시작)')"
      ;;
    system)
      echo "방식: systemd 시스템 서비스 ($SYSTEM_UNIT)"
      systemctl status "$NAME.service" --no-pager --lines=0 2>/dev/null | sed -n '1,5p' || true
      ;;
    cron)
      echo "방식: crontab @reboot"
      echo "  $(cron_line)"
      if pid="$(loop_pid)"; then echo "  실행 중 (루프 pid $pid)"; else echo "  안 돌고 있음"; fi
      ;;
  esac
  [[ -n $mode ]] && echo "로그: $LOG"
  return 0
}

print_files() {
  local mode=""
  case "${1:-}" in --user|--system|--cron) mode="${1#--}"; shift ;; esac
  [[ -n $mode ]] || mode="$( { [[ "$(uname)" == Linux ]] && pick_mode; } 2>/dev/null || echo user)"
  case "$mode" in
    user) echo "# ----- $USER_UNIT"; render_unit user "$@" ;;
    system) echo "# ----- $SYSTEM_UNIT"; render_unit system "$@" ;;
    cron) echo "# ----- crontab"; render_cron "$@" ;;
  esac
  echo
  echo "# ----- $ENV_FILE"
  render_env mask
}

linux_only() { [[ "$(uname)" == Linux ]] || { echo "autostart-linux.sh: Linux 전용 (macOS 는 ./autostart.sh)" >&2; exit 1; }; }

case "${1:-}" in
  install) shift; linux_only; do_install "$@" ;;
  uninstall) linux_only; uninstall ;;
  status) linux_only; status ;;
  print) shift; print_files "$@" ;; # 어느 OS 에서든 됨 (미리 보기)
  run) shift; run "$@" ;;           # cron 방식이 부름
  -h|--help|"") usage ;;
  *) echo "autostart-linux.sh: 모르는 명령 $1" >&2; usage >&2; exit 2 ;;
esac
