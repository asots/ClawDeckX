#!/bin/bash
set -e

CLAWDECKX_DATA_DIR="${OCD_DATA_DIR:-/data/clawdeckx}"
OPENCLAW_DATA_DIR="${OPENCLAW_DATA_DIR:-/data/openclaw}"
OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-${OPENCLAW_HOME:-$HOME}/.openclaw}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_STATE_DIR/openclaw.json}"
NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-$OPENCLAW_DATA_DIR/npm}"
GATEWAY_LOG="${OCD_GATEWAY_LOG:-$OPENCLAW_DATA_DIR/logs/gateway.log}"
GATEWAY_PORT="${OCD_OPENCLAW_GATEWAY_PORT:-18789}"
BOOTSTRAP_DIR="${OPENCLAW_DATA_DIR}/bootstrap"
BOOTSTRAP_FILE="${BOOTSTRAP_DIR}/gateway-bootstrap.json"

mkdir -p "$CLAWDECKX_DATA_DIR" "$OPENCLAW_DATA_DIR" "$OPENCLAW_STATE_DIR" "$OPENCLAW_DATA_DIR/logs" "$NPM_CONFIG_PREFIX" "$BOOTSTRAP_DIR"
export NPM_CONFIG_PREFIX
export PATH="$NPM_CONFIG_PREFIX/bin:$HOME/.local/bin:$HOME/bin:$PATH"
export OPENCLAW_STATE_DIR
export OPENCLAW_CONFIG_PATH="$OPENCLAW_CONFIG"

# write_bootstrap writes a JSON bootstrap status file for ClawDeckX to read
write_bootstrap() {
    local status="$1" reason="$2" pid="${3:-0}" openclaw_bin="${4:-}" openclaw_ver="${5:-}"
    BOOTSTRAP_FILE="$BOOTSTRAP_FILE" \
    BOOTSTRAP_STATUS="$status" \
    BOOTSTRAP_REASON="$reason" \
    BOOTSTRAP_PID="$pid" \
    BOOTSTRAP_OPENCLAW_BIN="$openclaw_bin" \
    BOOTSTRAP_OPENCLAW_VERSION="$openclaw_ver" \
    BOOTSTRAP_CONFIG_PATH="$OPENCLAW_CONFIG" \
    BOOTSTRAP_STATE_DIR="$OPENCLAW_STATE_DIR" \
    BOOTSTRAP_GATEWAY_LOG="$GATEWAY_LOG" \
    BOOTSTRAP_GATEWAY_PORT="$GATEWAY_PORT" \
    BOOTSTRAP_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    node -e 'const fs = require("fs"); const payload = { status: process.env.BOOTSTRAP_STATUS, reason: process.env.BOOTSTRAP_REASON, gatewayPid: Number(process.env.BOOTSTRAP_PID || "0"), gatewayPort: Number(process.env.BOOTSTRAP_GATEWAY_PORT || "0"), openclawBin: process.env.BOOTSTRAP_OPENCLAW_BIN || "", openclawVersion: process.env.BOOTSTRAP_OPENCLAW_VERSION || "", configPath: process.env.BOOTSTRAP_CONFIG_PATH || "", stateDir: process.env.BOOTSTRAP_STATE_DIR || "", gatewayLog: process.env.BOOTSTRAP_GATEWAY_LOG || "", timestamp: process.env.BOOTSTRAP_TIMESTAMP || "" }; fs.writeFileSync(process.env.BOOTSTRAP_FILE, JSON.stringify(payload, null, 2));'
}

ensure_default_clawhub() {
    if command -v clawhub &>/dev/null; then
        return 0
    fi

    if ! command -v npm &>/dev/null; then
        echo "[docker-entrypoint] npm not found, skipping ClawHub CLI auto-install" >&2
        return 1
    fi

    echo "[docker-entrypoint] Installing ClawHub CLI..."
    if npm install -g clawhub --prefix "$NPM_CONFIG_PREFIX" >/tmp/clawhub-install.log 2>&1; then
        echo "[docker-entrypoint] ClawHub CLI installed"
        return 0
    fi

    echo "[docker-entrypoint] WARNING: Failed to install ClawHub CLI" >&2
    tail -20 /tmp/clawhub-install.log 2>/dev/null >&2 || true
    return 1
}

ensure_default_skillhub() {
    if command -v skillhub &>/dev/null; then
        return 0
    fi

    if ! command -v curl &>/dev/null || ! command -v tar &>/dev/null || ! command -v bash &>/dev/null; then
        echo "[docker-entrypoint] Missing curl/tar/bash, skipping SkillHub CLI auto-install" >&2
        return 1
    fi

    local tmp_dir installer
    tmp_dir="$(mktemp -d)"
    trap 'rm -rf "$tmp_dir"' RETURN

    echo "[docker-entrypoint] Installing SkillHub CLI..."
    if ! curl -fsSL "https://skillhub-1251783334.cos.ap-guangzhou.myqcloud.com/install/latest.tar.gz" -o "$tmp_dir/latest.tar.gz" >/tmp/skillhub-install.log 2>&1; then
        echo "[docker-entrypoint] WARNING: Failed to download SkillHub CLI installer" >&2
        tail -20 /tmp/skillhub-install.log 2>/dev/null >&2 || true
        return 1
    fi

    if ! tar -xzf "$tmp_dir/latest.tar.gz" -C "$tmp_dir" >>/tmp/skillhub-install.log 2>&1; then
        echo "[docker-entrypoint] WARNING: Failed to extract SkillHub CLI installer" >&2
        tail -20 /tmp/skillhub-install.log 2>/dev/null >&2 || true
        return 1
    fi

    installer="$tmp_dir/cli/install.sh"
    if [ ! -f "$installer" ]; then
        echo "[docker-entrypoint] WARNING: SkillHub installer not found at $installer" >&2
        return 1
    fi

    if bash "$installer" >>/tmp/skillhub-install.log 2>&1; then
        echo "[docker-entrypoint] SkillHub CLI installed"
        return 0
    fi

    echo "[docker-entrypoint] WARNING: Failed to install SkillHub CLI" >&2
    tail -20 /tmp/skillhub-install.log 2>/dev/null >&2 || true
    return 1
}

ensure_default_openclaw_config() {
    if [ -f "$OPENCLAW_CONFIG" ]; then
        return 0
    fi

    echo "[docker-entrypoint] OpenClaw config not found, writing minimal config..."
    mkdir -p "$OPENCLAW_STATE_DIR"
    cat > "$OPENCLAW_CONFIG" <<OCEOF
{
  "gateway": {
    "mode": "local",
    "port": ${GATEWAY_PORT},
    "bind": "loopback"
  }
}
OCEOF
    chmod 600 "$OPENCLAW_CONFIG"
    echo "[docker-entrypoint] Minimal OpenClaw config written to $OPENCLAW_CONFIG"
    return 0
}

# Start OpenClaw Gateway in background if installed
OPENCLAW_BIN=""
OPENCLAW_VER=""
if command -v openclaw &>/dev/null; then
    OPENCLAW_BIN="$(command -v openclaw)"
    OPENCLAW_VER="$(openclaw --version 2>/dev/null || echo 'unknown')"
    echo "[docker-entrypoint] OpenClaw detected: ${OPENCLAW_BIN} (${OPENCLAW_VER})"
    echo "[docker-entrypoint] State dir: $OPENCLAW_STATE_DIR"
    echo "[docker-entrypoint] Config path: $OPENCLAW_CONFIG"
    echo "[docker-entrypoint] Gateway log: $GATEWAY_LOG"

    ensure_default_clawhub || true
    ensure_default_skillhub || true

    if ensure_default_openclaw_config; then
        echo "[docker-entrypoint] Starting OpenClaw gateway..."
        nohup openclaw gateway run --port "$GATEWAY_PORT" > "$GATEWAY_LOG" 2>&1 &
        GATEWAY_PID=$!
        # Wait for gateway to be ready (up to 15s)
        GATEWAY_STARTED=false
        for i in $(seq 1 15); do
            if curl -sf "http://127.0.0.1:${GATEWAY_PORT}/health" &>/dev/null; then
                echo "[docker-entrypoint] OpenClaw gateway started successfully (pid=$GATEWAY_PID)"
                GATEWAY_STARTED=true
                break
            fi
            # Check if process exited early
            if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
                echo "[docker-entrypoint] ERROR: OpenClaw gateway process exited prematurely" >&2
                tail -10 "$GATEWAY_LOG" 2>/dev/null >&2 || true
                write_bootstrap "failed" "gateway process exited prematurely" 0 "$OPENCLAW_BIN" "$OPENCLAW_VER"
                break
            fi
            sleep 1
        done
        if [ "$GATEWAY_STARTED" = true ]; then
            write_bootstrap "running" "gateway started successfully" "$GATEWAY_PID" "$OPENCLAW_BIN" "$OPENCLAW_VER"
        elif kill -0 "$GATEWAY_PID" 2>/dev/null; then
            echo "[docker-entrypoint] WARNING: OpenClaw gateway not ready within 15s (pid=$GATEWAY_PID)" >&2
            echo "[docker-entrypoint] Last gateway log lines:" >&2
            tail -10 "$GATEWAY_LOG" 2>/dev/null >&2 || true
            write_bootstrap "timeout" "gateway not ready within 15s" "$GATEWAY_PID" "$OPENCLAW_BIN" "$OPENCLAW_VER"
        fi
    else
        write_bootstrap "failed" "failed to generate initial config at ${OPENCLAW_CONFIG}" 0 "$OPENCLAW_BIN" "$OPENCLAW_VER"
    fi
else
    echo "[docker-entrypoint] OpenClaw not found in PATH, skipping gateway auto-start"
    echo "[docker-entrypoint] npm prefix: $NPM_CONFIG_PREFIX"
    write_bootstrap "not_installed" "openclaw command not found in PATH" 0 "" ""
fi

# Start ClawDeckX (exec replaces shell so tini can manage signals)
exec /app/clawdeckx serve "$@"
