#!/usr/bin/env bash
# Restore một dump .age từ R2 vào database ĐÍCH.
# Dùng cho DR hoặc restore drill. KHÔNG chạy lên DB thật khi chưa dừng api.
set -euo pipefail

# shellcheck disable=SC1091
[ -f /etc/videoai/env ] && . /etc/videoai/env

APP_DIR="${APP_DIR:-/opt/videoai}"
COMPOSE_FILE="${COMPOSE_FILE:-${APP_DIR}/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-${APP_DIR}/.env}"
AGE_IDENTITY_FILE="${AGE_IDENTITY_FILE:-/root/videoai-backup.key}"
SOURCE="${1:-}"
TARGET_DB="${2:-}"

[ -n "$SOURCE" ] || { echo "usage: $0 <r2-path.dump.age> <target-db>" >&2; exit 2; }
[ -n "$TARGET_DB" ] || { echo "usage: $0 <r2-path.dump.age> <target-db>" >&2; exit 2; }

cd "$APP_DIR"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

echo "[restore] source=$SOURCE target=$TARGET_DB"
echo "[restore] nếu target là DB thật, hãy chắc chắn api đã stop."

rclone cat "$SOURCE" \
  | age -d -i "$AGE_IDENTITY_FILE" \
  | docker compose -f "$COMPOSE_FILE" exec -T postgres \
      pg_restore -U "${DB_USER:-video_ai_user}" -d "$TARGET_DB" --no-owner --clean --if-exists

echo "[restore] done"
