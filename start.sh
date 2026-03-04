#!/usr/bin/env bash
# start.sh — Launch The Companion with IPtables lockdown
#
# Usage:
#   ./start.sh              # production (port 3456)
#   ./start.sh --dev        # dev mode with Vite HMR (port 3457)
#   ./start.sh --port 8080  # custom port
#
# First run: you need sudo for IPtables. After that, if rules are persisted
# they will survive reboot and you can run without sudo.
#
# After startup, generate a registration link:
#   bun web/bin/companion-admin.ts create-invite

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_MODE=false
PORT="${PORT:-3456}"

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev)    DEV_MODE=true; PORT=3457; shift ;;
    --port)   PORT="$2"; shift 2 ;;
    --help)
      echo "Usage: $0 [--dev] [--port <n>]"
      exit 0
      ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

export PORT

# ── Step 1: Apply IPtables lockdown ──────────────────────────────────────────
echo "[start] Applying IPtables lockdown..."

LOCK_SCRIPT="$SCRIPT_DIR/scripts/iptables-lockdown.sh"

if [[ $EUID -eq 0 ]]; then
  COMPANION_PORT="$PORT" bash "$LOCK_SCRIPT"
elif command -v sudo &>/dev/null; then
  COMPANION_PORT="$PORT" sudo bash "$LOCK_SCRIPT"
else
  echo "[start] WARNING: Cannot apply IPtables rules (not root and no sudo)."
  echo "         Run manually: sudo COMPANION_PORT=$PORT bash $LOCK_SCRIPT"
fi

# ── Step 2: Verify port is loopback-only ─────────────────────────────────────
echo "[start] Verifying port $PORT is locked to loopback..."
IPTABLES_CHECK_CMD="iptables"
command -v sudo &>/dev/null && IPTABLES_CHECK_CMD="sudo iptables"
if $IPTABLES_CHECK_CMD -C INPUT -p tcp --dport "$PORT" ! -i lo -j DROP 2>/dev/null; then
  echo "[start] Port $PORT is locked to loopback only."
else
  echo "[start] WARNING: Could not confirm port $PORT lockdown — check iptables manually."
fi

# ── Step 3: Check bun is available ───────────────────────────────────────────
BUN_BIN=""
for candidate in bun "$HOME/.bun/bin/bun" "$HOME/.npm-global/bin/bun"; do
  if command -v "$candidate" &>/dev/null; then
    BUN_BIN="$candidate"
    break
  fi
done

if [[ -z "$BUN_BIN" ]]; then
  echo "[start] ERROR: bun not found. Install bun: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

echo "[start] Using bun: $($BUN_BIN --version)"

# ── Step 4: Build frontend if production ─────────────────────────────────────
if [[ "$DEV_MODE" == "false" ]]; then
  echo "[start] Building frontend..."
  (cd "$SCRIPT_DIR/web" && "$BUN_BIN" run build)
fi

# ── Step 5: Start the server ──────────────────────────────────────────────────
echo ""
echo "[start] Starting companion on http://localhost:$PORT"
echo "[start] To register a passkey device, run in another terminal:"
echo "         $BUN_BIN $SCRIPT_DIR/web/bin/companion-admin.ts create-invite --port $PORT"
echo ""

if [[ "$DEV_MODE" == "true" ]]; then
  cd "$SCRIPT_DIR/web" && exec "$BUN_BIN" run dev
else
  cd "$SCRIPT_DIR/web" && NODE_ENV=production exec "$BUN_BIN" server/index.ts
fi
