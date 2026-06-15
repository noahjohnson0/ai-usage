#!/usr/bin/env bash
LOG="$HOME/ai-usage/profile-watch.log"
echo "$(date -u +%FT%TZ)  WATCH START — checking github.com/noahjohnson0 profile README every 20min (read-only, no repo changes)" >> "$LOG"
for i in $(seq 1 72); do
  sz=$(gh api repos/noahjohnson0/noahjohnson0 -q .size 2>/dev/null)
  pm=$(curl -s -A "Mozilla/5.0 (X11)" "https://github.com/noahjohnson0?_=$RANDOM" 2>/dev/null | grep -ioc -E "profile-readme|My AI coding usage" || true)
  echo "$(date -u +%FT%TZ)  check#$i  size=$sz  profile-markers=${pm:-0}" >> "$LOG"
  if [ "${pm:-0}" -gt 0 ]; then
    echo "$(date -u +%FT%TZ)  ✅ SUCCESS — profile README is LIVE after check#$i" >> "$LOG"
    exit 0
  fi
  sleep 1200
done
echo "$(date -u +%FT%TZ)  ⛔ gave up after 72 checks (~24h) — still not rendering; escalate to GitHub Support" >> "$LOG"
exit 2
