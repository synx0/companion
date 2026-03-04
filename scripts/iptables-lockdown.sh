#!/usr/bin/env bash
# iptables-lockdown.sh — Lock down companion server to loopback only
#
# Blocks all external access to the companion port (3456/3457).
# Also locks the DOCKER-USER chain so Docker-published ports cannot be
# reached from outside the machine.
#
# Run with: sudo bash scripts/iptables-lockdown.sh
# Teardown:  sudo bash scripts/iptables-lockdown.sh --undo
#
# Idempotent — safe to run multiple times.

set -euo pipefail

COMPANION_PORT="${COMPANION_PORT:-3456}"
COMPANION_DEV_PORT="${COMPANION_DEV_PORT:-3457}"
COMMENT_TAG="companion-lockdown"

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[lockdown]${NC} $*"; }
warn()  { echo -e "${YELLOW}[lockdown]${NC} $*"; }
error() { echo -e "${RED}[lockdown]${NC} $*" >&2; }

# ── Require root ──────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  error "Must be run as root (try: sudo $0 $*)"
  exit 1
fi

# ── Undo mode ─────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--undo" ]]; then
  warn "Removing companion lockdown rules..."

  # Remove INPUT rules for companion ports
  for PORT in "$COMPANION_PORT" "$COMPANION_DEV_PORT"; do
    while iptables -D INPUT -p tcp --dport "$PORT" ! -i lo -j DROP 2>/dev/null; do
      info "  Removed INPUT drop rule for port $PORT"
    done
  done

  # Remove DOCKER-USER lockdown rules (they were appended, remove by spec)
  while iptables -D DOCKER-USER -m comment --comment "$COMMENT_TAG" -j DROP 2>/dev/null; do
    info "  Removed DOCKER-USER drop rule"
  done
  while iptables -D DOCKER-USER -i lo -m comment --comment "$COMMENT_TAG" -j RETURN 2>/dev/null; do
    info "  Removed DOCKER-USER loopback allow rule"
  done
  while iptables -D DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment "$COMMENT_TAG" -j RETURN 2>/dev/null; do
    info "  Removed DOCKER-USER conntrack rule"
  done

  info "Lockdown removed. Companion ports are now externally accessible."
  exit 0
fi

# ── Apply lockdown ────────────────────────────────────────────────────────────
info "Applying IPtables lockdown for companion (ports $COMPANION_PORT, $COMPANION_DEV_PORT)..."

# 1. Block all non-loopback TCP access to companion ports
for PORT in "$COMPANION_PORT" "$COMPANION_DEV_PORT"; do
  # Check if rule already exists
  if ! iptables -C INPUT -p tcp --dport "$PORT" ! -i lo -j DROP 2>/dev/null; then
    iptables -I INPUT 1 -p tcp --dport "$PORT" ! -i lo -j DROP
    info "  Blocked external access to port $PORT"
  else
    warn "  Rule already exists for port $PORT (skipping)"
  fi
done

# 2. Lock down Docker-published ports via DOCKER-USER chain
#    The DOCKER-USER chain is the correct place to add firewall rules that
#    affect Docker containers without interfering with Docker's own rules.
if iptables -L DOCKER-USER -n &>/dev/null; then
  # Allow already-established connections
  if ! iptables -C DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED \
       -m comment --comment "$COMMENT_TAG" -j RETURN 2>/dev/null; then
    iptables -I DOCKER-USER 1 -m conntrack --ctstate ESTABLISHED,RELATED \
      -m comment --comment "$COMMENT_TAG" -j RETURN
    info "  DOCKER-USER: allow established connections"
  fi

  # Allow loopback
  if ! iptables -C DOCKER-USER -i lo \
       -m comment --comment "$COMMENT_TAG" -j RETURN 2>/dev/null; then
    iptables -I DOCKER-USER 2 -i lo \
      -m comment --comment "$COMMENT_TAG" -j RETURN
    info "  DOCKER-USER: allow loopback interface"
  fi

  # Drop everything else
  if ! iptables -C DOCKER-USER -m comment --comment "$COMMENT_TAG" -j DROP 2>/dev/null; then
    iptables -A DOCKER-USER -m comment --comment "$COMMENT_TAG" -j DROP
    info "  DOCKER-USER: drop all external access to Docker containers"
  fi
else
  warn "  DOCKER-USER chain not found — Docker may not be running. Skipping Docker lockdown."
fi

# 3. Persist rules so they survive reboot
if command -v iptables-save &>/dev/null; then
  if command -v netfilter-persistent &>/dev/null; then
    netfilter-persistent save &>/dev/null && info "  Rules persisted via netfilter-persistent"
  elif [[ -f /etc/iptables/rules.v4 ]]; then
    iptables-save > /etc/iptables/rules.v4 && info "  Rules saved to /etc/iptables/rules.v4"
  else
    warn "  Cannot auto-persist rules. Install iptables-persistent or save manually:"
    warn "    sudo iptables-save > /etc/iptables/rules.v4"
  fi
fi

# 4. Verify
echo ""
info "Verification:"
for PORT in "$COMPANION_PORT" "$COMPANION_DEV_PORT"; do
  if iptables -C INPUT -p tcp --dport "$PORT" ! -i lo -j DROP 2>/dev/null; then
    echo -e "  Port $PORT: ${GREEN}LOCKED (loopback only)${NC}"
  else
    echo -e "  Port $PORT: ${RED}NOT LOCKED${NC}"
  fi
done

echo ""
info "Done. Companion is now accessible on localhost only."
info "To undo: sudo bash scripts/iptables-lockdown.sh --undo"
