#!/usr/bin/env bash
# One-shot setup for a macOS reporter (e.g. the MacBook M4 Max).
# Clones/updates the repo, does a first collect+push, and installs a launchd
# agent that runs daily at noon.
#
#   git clone https://github.com/noahjohnson0/ai-usage.git ~/ai-usage \
#     && AI_USAGE_MACHINE=macbook-m4-max bash ~/ai-usage/scripts/setup-mac.sh
#
# Requires: node >=22 and git push auth (run `gh auth login` first, or have a
# credential helper configured). ccusage is fetched on demand via npx.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MACHINE="${AI_USAGE_MACHINE:-macbook-m4-max}"
NODE_BIN="$(command -v node || true)"

if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH. Install Node 22+ (e.g. 'brew install node') and re-run." >&2
  exit 1
fi
echo "repo:    $REPO_DIR"
echo "machine: $MACHINE"
echo "node:    $NODE_BIN"

echo "== first collect + push =="
( cd "$REPO_DIR" && AI_USAGE_MACHINE="$MACHINE" "$NODE_BIN" reporter/collect.mjs --push ) || \
  echo "(push may have failed if git auth isn't set up — run 'gh auth login' then retry)"

PLIST="$HOME/Library/LaunchAgents/com.ai-usage.reporter.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ai-usage.reporter</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>cd "$REPO_DIR" && AI_USAGE_MACHINE="$MACHINE" node reporter/collect.mjs --push >> "$REPO_DIR/scripts/last-run.log" 2>&1</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "== installed launchd agent: $PLIST (daily 12:00) =="
echo "done. Verify the slice at data/machines/$MACHINE.json was pushed."
