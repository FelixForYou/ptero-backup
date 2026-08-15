#!/usr/bin/env bash
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive

if [[ "$(id -u)" != "0" ]]; then
  echo "Installer harus dijalankan sebagai root." >&2
  exit 1
fi

if command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates tar gzip zstd util-linux mariadb-client >/dev/null
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y curl ca-certificates tar gzip zstd util-linux mariadb >/dev/null
else
  echo "OS belum didukung otomatis. Gunakan Ubuntu/Debian/RHEL-family." >&2
  exit 1
fi

if ! command -v rclone >/dev/null 2>&1; then
  curl -fsSL https://rclone.org/install.sh | bash >/dev/null
fi

mkdir -p /opt/ptero-drive-backup /var/cache/ptero-drive-backup
chmod 700 /opt/ptero-drive-backup /var/cache/ptero-drive-backup

echo "READY"
