#!/usr/bin/env bash
# 启动 / 停止 A2S 统一中转服务器。
#   ./start.sh          启动（后台，写 pid 与日志）
#   ./start.sh stop     停止
#   ./start.sh restart  重启
#   ./start.sh status   查看状态
#   ./start.sh logs     跟踪日志
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${A2S_SERVER_DATA_DIR:-${DSH_RELAY_DATA_DIR:-$HOME/.a2s-server}}"
PID_FILE="$DATA_DIR/relay.pid"
LOG_FILE="$DATA_DIR/relay.log"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
PORT="${A2S_SERVER_PORT:-${DSH_RELAY_PORT:-50443}}"

mkdir -p "$DATA_DIR"

running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

case "${1:-start}" in
  start)
    if running; then
      echo "已在运行（pid $(cat "$PID_FILE")）"
      exit 0
    fi
    cd "$DIR"
    export A2S_SERVER_DATA_DIR="$DATA_DIR"
    nohup "$NODE_BIN" server.js >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 1
    if running; then
      echo "已启动（pid $(cat "$PID_FILE")）"
      echo "日志：$LOG_FILE"
    else
      echo "启动失败，请看 $LOG_FILE" >&2
      exit 1
    fi
    ;;
  stop)
    if running; then
      kill "$(cat "$PID_FILE")"
      rm -f "$PID_FILE"
      echo "已停止"
    else
      echo "没有在运行"
    fi
    ;;
  restart)
    "$0" stop || true
    sleep 1
    "$0" start
    ;;
  status)
    if running; then
      echo "运行中（pid $(cat "$PID_FILE")）"
      curl -sk "https://127.0.0.1:${PORT}/a2s-api/health" 2>/dev/null \
        || curl -s "http://127.0.0.1:${PORT}/a2s-api/health" 2>/dev/null \
        || true
      echo
    else
      echo "未运行"
    fi
    ;;
  logs)
    tail -f "$LOG_FILE"
    ;;
  *)
    echo "用法：$0 {start|stop|restart|status|logs}" >&2
    exit 1
    ;;
esac
