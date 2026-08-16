#!/usr/bin/env bash
# Flight Deal Intelligence — one-shot VPS installer (Ubuntu/Debian).
# Installs Node 22 + Python deps, sets up the app as two systemd services
# (api + worker) that start on boot and restart on failure, and optionally
# puts Caddy in front for automatic HTTPS on your domain.
#
# Usage:
#   bash scripts/vps-install.sh                 # app on http://SERVER_IP:3010
#   DOMAIN=flights.example.com bash scripts/vps-install.sh   # + HTTPS via Caddy
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "==> Installing Flight Deal Intelligence from $APP_DIR"

# run without sudo when already root (common on fresh VPSes)
if [[ $EUID -eq 0 ]]; then SUDO=""; else SUDO="sudo"; fi

# --- system deps ---
if ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 22 ]]; then
  echo "==> Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi
$SUDO apt-get update -y || true
$SUDO apt-get install -y python3 python3-pip || true
$SUDO apt-get install -y pipx || true   # not present in older Debian repos — pip fallback below
python3 -m pip install --break-system-packages -q fast-flights typing_extensions || \
  python3 -m pip install -q fast-flights typing_extensions
if command -v pipx >/dev/null; then
  pipx install 'flights[mcp]' 2>/dev/null || true
  pipx ensurepath || true
else
  python3 -m pip install --break-system-packages -q 'flights[mcp]' || \
    python3 -m pip install -q 'flights[mcp]' || true
fi

# --- app deps ---
cd "$APP_DIR"
npm install --omit=dev
npm i tsx typescript
[[ -f .env ]] || cp .env.example .env
mkdir -p data

# --- systemd services ---
if ! command -v systemctl >/dev/null; then
  echo "!! systemd not found — this must run on a real VPS (Ubuntu/Debian)."
  echo "   App deps are installed; you can still start manually with:"
  echo "   npm run dev   and   npm run worker"
  exit 1
fi
echo "==> Creating systemd services"
$SUDO tee /etc/systemd/system/flight-intel-api.service > /dev/null <<EOF
[Unit]
Description=Flight Deal Intelligence API + dashboard
After=network-online.target

[Service]
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=PATH=/root/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$(command -v npx) tsx src/api/server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

$SUDO tee /etc/systemd/system/flight-intel-worker.service > /dev/null <<EOF
[Unit]
Description=Flight Deal Intelligence monitoring worker (24/7 price agent)
After=network-online.target

[Service]
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=PATH=/root/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$(command -v npx) tsx src/worker/monitor.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now flight-intel-api flight-intel-worker
echo "==> Services running: flight-intel-api (port 3010), flight-intel-worker"

# --- optional HTTPS with Caddy ---
if [[ -n "${DOMAIN:-}" ]]; then
  echo "==> Setting up Caddy for https://$DOMAIN"
  if ! command -v caddy >/dev/null; then
    $SUDO apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | $SUDO gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list
    $SUDO apt-get update && $SUDO apt-get install -y caddy
  fi
  printf '%s {\n\treverse_proxy localhost:3010\n}\n' "$DOMAIN" | $SUDO tee /etc/caddy/Caddyfile
  $SUDO systemctl reload caddy
  echo "==> Done: https://$DOMAIN"
else
  echo "==> Done: http://$(hostname -I | awk '{print $1}'):3010"
  echo "    (re-run with DOMAIN=your.domain.com for automatic HTTPS)"
fi

echo "
Next steps:
  1. Edit $APP_DIR/.env — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID for phone alerts
  2. Open the dashboard, search a route, click 'עקוב אחרי המסלול'
  3. The worker checks prices 24/7 (adaptive 30m-24h) and alerts on drops
Logs:   journalctl -u flight-intel-worker -f
Status: systemctl status flight-intel-api flight-intel-worker
"
