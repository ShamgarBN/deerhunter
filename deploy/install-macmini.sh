#!/usr/bin/env bash
# Install DeerHunter as a launchd service on the Mac mini.
# Run this ON the mini, from the repo root: ./deploy/install-macmini.sh
#
# Separate from Scuttlebutt by design: its own process, port and launchd label, so a
# crash or restart in one does not take the other down.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.benniemann.deerhunter"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
NODE_BIN="$(command -v node)"
PORT="$(node -p "require('${REPO}/config/config.json').server.port")"

echo "Repo:  $REPO"
echo "Node:  $NODE_BIN ($(node -v))"
echo "Port:  $PORT"

if [ ! -d "$REPO/node_modules" ]; then
  echo "Installing dependencies..."
  (cd "$REPO" && npm install)
fi

echo "Priming: fetching weather and scoring the season..."
(cd "$REPO" && node src/cli.js refresh) || echo "  (refresh failed; the service will retry on its own schedule)"

mkdir -p "$HOME/Library/LaunchAgents" "$REPO/logs"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${REPO}/src/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${REPO}/logs/deerhunter.log</string>
  <key>StandardErrorPath</key><string>${REPO}/logs/deerhunter.error.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
</dict>
</plist>
PLISTEOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

sleep 2
if curl -sf "http://localhost:${PORT}/api/state" >/dev/null; then
  echo
  echo "Running. The scheduler is armed inside the server process:"
  node -p "const c=require('${REPO}/config/config.json'); \`  refresh  \${c.schedule.refreshCron}\n  alerts   \${c.schedule.alertCron}  (\${c.property.timezone})\`"
  echo
  echo "Local:     http://localhost:${PORT}"
  TS="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
  if [ -x "$TS" ]; then
    HOSTNAME_TS="$("$TS" status --json 2>/dev/null | node -p "try{JSON.parse(require('fs').readFileSync(0,'utf8')).Self.DNSName.replace(/\.$/,'')}catch(e){''}" 2>/dev/null || true)"
    [ -n "$HOSTNAME_TS" ] && echo "Tailscale: http://${HOSTNAME_TS}:${PORT}"
  fi
  echo
  echo "Logs:      tail -f ${REPO}/logs/deerhunter.log"
  echo "Stop:      launchctl unload ${PLIST}"
else
  echo "Service did not answer on port ${PORT}. Check ${REPO}/logs/deerhunter.error.log"
  exit 1
fi
