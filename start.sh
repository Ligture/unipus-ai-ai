#!/bin/bash
# ============================================
#   Unipus API 启动脚本 (Linux)
# ============================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

# --- 参数解析 ---
DAEMON=false
STOP=false
STATUS=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -d|--daemon)  DAEMON=true;  shift ;;
        -s|--stop)    STOP=true;    shift ;;
        --status)     STATUS=true;  shift ;;
        -h|--help)
            echo "用法: ./start.sh [选项]"
            echo "  -d, --daemon   后台运行"
            echo "  -s, --stop     停止后台服务"
            echo "  --status       查看服务状态"
            echo "  -h, --help     显示帮助"
            exit 0 ;;
        *) error "未知参数: $1"; exit 1 ;;
    esac
done

PID_FILE="$SCRIPT_DIR/.unipus.pid"
LOG_OUT="$SCRIPT_DIR/logs/stdout.log"

# --- 停止服务 ---
if $STOP; then
    if [[ -f "$PID_FILE" ]]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            info "停止 Unipus API (PID: $PID) ..."
            kill "$PID"
            rm -f "$PID_FILE"
            info "服务已停止"
        else
            warn "进程 $PID 已不存在，清理 PID 文件"
            rm -f "$PID_FILE"
        fi
    else
        warn "未找到 PID 文件，服务可能未在运行"
    fi
    exit 0
fi

# --- 查看状态 ---
if $STATUS; then
    if [[ -f "$PID_FILE" ]]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            info "Unipus API 正在运行 (PID: $PID)"
        else
            warn "PID 文件存在但进程已退出 (PID: $PID)"
        fi
    else
        warn "Unipus API 未在运行"
    fi
    exit 0
fi

# --- 检查环境 ---
# 激活虚拟环境
if [[ -f ".venv/bin/activate" ]]; then
    info "激活虚拟环境 .venv ..."
    source .venv/bin/activate
elif [[ -f "venv/bin/activate" ]]; then
    info "激活虚拟环境 venv ..."
    source venv/bin/activate
else
    warn "未找到虚拟环境，使用系统 Python"
fi

# 检查 config.yaml
if [[ ! -f "config.yaml" ]]; then
    warn "未找到 config.yaml"
    if [[ -f "config.example.yaml" ]]; then
        info "复制 config.example.yaml -> config.yaml"
        cp config.example.yaml config.yaml
        warn "请编辑 config.yaml 填入你的 API 密钥后再启动"
        exit 1
    fi
fi

# 创建必要目录
mkdir -p logs audio_files

# --- 启动服务 ---
if $DAEMON; then
    # 检查是否已在运行
    if [[ -f "$PID_FILE" ]]; then
        OLD_PID=$(cat "$PID_FILE")
        if kill -0 "$OLD_PID" 2>/dev/null; then
            error "服务已在运行 (PID: $OLD_PID)，请先停止"
            exit 1
        fi
        rm -f "$PID_FILE"
    fi

    info "后台启动 Unipus API ..."
    nohup python api.py > "$LOG_OUT" 2>&1 &
    echo $! > "$PID_FILE"
    info "服务已启动 (PID: $!)"
    info "日志文件: $LOG_OUT"
    info "停止命令: ./start.sh --stop"
else
    info "启动 Unipus API (前台模式) ..."
    info "按 Ctrl+C 停止服务"
    echo ""
    python api.py
fi
