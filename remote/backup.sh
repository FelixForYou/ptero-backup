#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP_DIR="/opt/ptero-drive-backup"
CONFIG="$APP_DIR/config.env"
RCLONE_CONFIG="$APP_DIR/rclone.conf"
LOG="/var/log/ptero-drive-backup.log"
LOCK="/run/lock/ptero-drive-backup.lock"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[$(date -Is)] Backup lain masih berjalan, skip." >> "$LOG"
  exit 0
fi

if [[ ! -f "$CONFIG" ]]; then
  echo "[$(date -Is)] config.env tidak ditemukan." >> "$LOG"
  exit 1
fi
# shellcheck disable=SC1090
source "$CONFIG"

PANEL_DIR="${PANEL_DIR:-/var/www/pterodactyl}"
REMOTE_NAME="${REMOTE_NAME:-ptero-drive}"
REMOTE_DIR="${REMOTE_DIR:-PterodactylBackups}"
BACKUP_SCOPE="${BACKUP_SCOPE:-full}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
HOST_LABEL="${HOST_LABEL:-$(hostname -s)}"

mkdir -p /var/cache/ptero-drive-backup
TMP_DIR="$(mktemp -d /var/cache/ptero-drive-backup/job.XXXXXX)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

log() { echo "[$(date -Is)] $*" | tee -a "$LOG"; }

if [[ ! -f "$PANEL_DIR/.env" ]]; then
  log "ERROR: $PANEL_DIR/.env tidak ditemukan."
  exit 1
fi

php_env() {
  local key="$1"
  (cd "$PANEL_DIR" && php -r '
    require "vendor/autoload.php";
    $dotenv = Dotenv\Dotenv::createImmutable(__DIR__);
    $dotenv->safeLoad();
    $k = $argv[1];
    echo $_ENV[$k] ?? getenv($k) ?: "";
  ' "$key")
}

DB_HOST="$(php_env DB_HOST)"
DB_PORT="$(php_env DB_PORT)"
DB_NAME="$(php_env DB_DATABASE)"
DB_USER="$(php_env DB_USERNAME)"
DB_PASS="$(php_env DB_PASSWORD)"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"

if [[ -z "$DB_NAME" || -z "$DB_USER" ]]; then
  log "ERROR: konfigurasi database tidak bisa dibaca dari .env."
  exit 1
fi

DUMPER=""
if command -v mariadb-dump >/dev/null 2>&1; then DUMPER="mariadb-dump"; fi
if [[ -z "$DUMPER" ]] && command -v mysqldump >/dev/null 2>&1; then DUMPER="mysqldump"; fi
if [[ -z "$DUMPER" ]]; then
  log "ERROR: mariadb-dump/mysqldump tidak tersedia."
  exit 1
fi

log "Dump database $DB_NAME..."
export MYSQL_PWD="$DB_PASS"
"$DUMPER" \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --user="$DB_USER" \
  --single-transaction \
  --quick \
  --routines \
  --triggers \
  "$DB_NAME" | gzip -1 > "$TMP_DIR/pterodactyl-database.sql.gz"
unset MYSQL_PWD

cat > "$TMP_DIR/manifest.txt" <<MANIFEST
created_at=$(date -Is)
host=$(hostname -f 2>/dev/null || hostname)
scope=$BACKUP_SCOPE
panel_dir=$PANEL_DIR
rclone=$(rclone version | head -n1)
MANIFEST

PATHS=()
add_path() {
  local p="${1#/}"
  [[ -e "/$p" ]] && PATHS+=("$p")
}

if [[ "$BACKUP_SCOPE" == "panel" || "$BACKUP_SCOPE" == "full" ]]; then
  add_path "$PANEL_DIR"
  add_path "/etc/pterodactyl"
  add_path "/etc/systemd/system/wings.service"
  add_path "/etc/systemd/system/pteroq.service"
  add_path "/etc/nginx/sites-available"
  add_path "/etc/nginx/sites-enabled"
  add_path "/etc/apache2/sites-available"
  add_path "/etc/apache2/sites-enabled"
  add_path "/etc/letsencrypt"
fi

if [[ "$BACKUP_SCOPE" == "servers" || "$BACKUP_SCOPE" == "full" ]]; then
  # Default Wings server directory.
  add_path "/var/lib/pterodactyl/volumes"

  # Local Pterodactyl backups may use a custom backup_directory in config.yml.
  if [[ -f /etc/pterodactyl/config.yml ]]; then
    CUSTOM_BACKUP_DIR="$(awk '
      /^system:/ {in_system=1; next}
      in_system && /^[^[:space:]]/ {in_system=0}
      in_system && /^[[:space:]]+backup_directory:/ {
        sub(/^[[:space:]]+backup_directory:[[:space:]]*/, ""); gsub(/["\047]/, ""); print; exit
      }
    ' /etc/pterodactyl/config.yml || true)"
    [[ -n "$CUSTOM_BACKUP_DIR" ]] && add_path "$CUSTOM_BACKUP_DIR"
  fi
fi

if [[ ${#PATHS[@]} -eq 0 ]]; then
  log "ERROR: tidak ada path backup yang ditemukan."
  exit 1
fi

STAMP="$(date +%Y-%m-%d_%H-%M-%S)"
REMOTE_PATH="${REMOTE_NAME}:${REMOTE_DIR}/${HOST_LABEL}/pterodactyl-${BACKUP_SCOPE}-${STAMP}.tar.zst"

log "Mulai streaming ${#PATHS[@]} path ke $REMOTE_PATH"
{
  tar --warning=no-file-changed --ignore-failed-read -C / -cf - "${PATHS[@]}" -C "$TMP_DIR" pterodactyl-database.sql.gz manifest.txt
} | zstd -T0 -3 -q | rclone --config="$RCLONE_CONFIG" rcat "$REMOTE_PATH" \
      --drive-chunk-size 64M \
      --transfers 1 \
      --checkers 4 \
      --stats 30s \
      --log-level INFO \
      --log-file "$LOG"

log "Upload selesai: $REMOTE_PATH"

if [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] && (( RETENTION_DAYS > 0 )); then
  log "Hapus backup lebih lama dari ${RETENTION_DAYS} hari..."
  rclone --config="$RCLONE_CONFIG" delete "${REMOTE_NAME}:${REMOTE_DIR}/${HOST_LABEL}" \
    --min-age "${RETENTION_DAYS}d" \
    --include "pterodactyl-*.tar.zst" \
    --rmdirs || true
fi

log "Backup selesai."
