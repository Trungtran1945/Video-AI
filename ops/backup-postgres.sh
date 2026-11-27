#!/usr/bin/env bash
# Backup PostgreSQL hourly: pg_dump -Fc | age | rclone rcat -> Cloudflare R2.
# Yêu cầu: docker compose stack đang chạy, age + rclone đã cài trên host.
set -euo pipefail

# shellcheck disable=SC1091
[ -f /etc/videoai/env ] && . /etc/videoai/env

APP_DIR="${APP_DIR:-/opt/videoai}"
COMPOSE_FILE="${COMPOSE_FILE:-${APP_DIR}/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-${APP_DIR}/.env}"
AGE_RECIPIENT_FILE="${AGE_RECIPIENT_FILE:-/etc/videoai/age-recipient.txt}"
R2_REMOTE="${R2_REMOTE:-r2:videoai-backups}"
HC_URL="${HC_BACKUP_URL:-}"

cd "$APP_DIR"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
HOURLY_KEY="db/hourly/${STAMP}.dump.age"

fail() {
  echo "[backup] ERROR: $*" >&2
  if [ -n "$HC_URL" ]; then curl -fsS -m 10 --retry 3 "${HC_URL}/fail" || true; fi
  exit 1
}
trap 'fail "line $LINENO"' ERR

RECIPIENT="$(tr -d '\n' < "$AGE_RECIPIENT_FILE")"
[ -n "$RECIPIENT" ] || fail "empty age recipient in $AGE_RECIPIENT_FILE"

docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U "${DB_USER:-video_ai_user}" -d "${DB_NAME:-video_ai}" -Fc \
  | age -r "$RECIPIENT" \
  | rclone rcat "${R2_REMOTE}/${HOURLY_KEY}"

# Giữ 72 giờ bản hourly.
rclone delete "${R2_REMOTE}/db/hourly" --min-age 72h

# 03:00 UTC mỗi ngày: copy thành bản daily, giữ 14 ngày.
if [ "$(date -u +%H)" = "03" ]; then
  rclone copyto "${R2_REMOTE}/${HOURLY_KEY}" "${R2_REMOTE}/db/daily/$(date -u +%Y%m%d).dump.age"
  rclone delete "${R2_REMOTE}/db/daily" --min-age 14d
fi

if [ -n "$HC_URL" ]; then curl -fsS -m 10 --retry 3 "$HC_URL" >/dev/null; fi
echo "[backup] ok ${HOURLY_KEY}"
