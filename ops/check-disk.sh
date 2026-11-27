#!/usr/bin/env bash
# Alert khi filesystem / vượt ngưỡng. Ping Healthchecks mỗi lần chạy.
set -euo pipefail

# shellcheck disable=SC1091
[ -f /etc/videoai/env ] && . /etc/videoai/env

THRESHOLD="${DISK_ALERT_PERCENT:-80}"
HC_URL="${HC_DISK_URL:-}"
USED="$(df -P / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"

if [ "$USED" -ge "$THRESHOLD" ]; then
  echo "[disk] ALERT ${USED}% used (threshold ${THRESHOLD}%)" >&2
  if [ -n "$HC_URL" ]; then curl -fsS -m 10 "${HC_URL}/fail" || true; fi
  exit 1
fi

if [ -n "$HC_URL" ]; then curl -fsS -m 10 "$HC_URL" >/dev/null || true; fi
echo "[disk] ok ${USED}% used"
