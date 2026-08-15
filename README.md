# Ptero Drive Web

Web wizard untuk memasang backup Pterodactyl → Google Drive tanpa perlu menjalankan command manual di VPS target.

## Alur

1. Masukkan IP VPS, port SSH, root, dan password.
2. Web login via SSH dan otomatis memasang `rclone`, `zstd`, dan kebutuhan backup.
3. Klik **Hubungkan Google Drive**.
4. Pilih full/panel/server-only, jadwal 1 jam / 6 jam / 12 jam / harian, dan retensi.
5. Web memasang `/opt/ptero-drive-backup/backup.sh` serta `systemd timer` di VPS target.
6. Password VPS tidak disimpan ke disk oleh aplikasi. Sesi SSH setup ditutup setelah instalasi.

## Data yang dibackup

### Full
- `/var/www/pterodactyl` termasuk `.env`
- dump database MariaDB/MySQL
- `/etc/pterodactyl`
- Wings/pteroq systemd unit bila ada
- konfigurasi Nginx/Apache bila ada
- `/etc/letsencrypt` bila ada
- `/var/lib/pterodactyl/volumes`
- `system.backup_directory` dari Wings jika terdeteksi

Docker image layers tidak dibackup karena dapat ditarik ulang dan menyalin `/var/lib/docker` saat Docker hidup berisiko menghasilkan backup yang tidak konsisten.

## Google OAuth

Rclone shared Google Drive client ID sedang dihentikan pada 2026, jadi project ini memakai OAuth Client milik kamu sendiri.

Di Google Cloud Console:

1. Buat project.
2. Aktifkan Google Drive API.
3. Buat OAuth 2.0 Client ID tipe **Web application**.
4. Tambahkan Authorized redirect URI:
   `https://DOMAIN-WEB-KAMU/oauth/google/callback`
5. Salin Client ID dan Client Secret ke `.env`.

Scope yang dipakai adalah `drive.file`: aplikasi hanya bisa melihat/mengubah file yang dibuat oleh aplikasi itu sendiri.

## Environment

Copy `.env.example` menjadi `.env` lalu isi:

```env
PORT=3000
PUBLIC_URL=https://backup.example.com
ADMIN_KEY=password-web-yang-panjang
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxx
GOOGLE_REDIRECT_URI=https://backup.example.com/oauth/google/callback
JOB_TTL_MINUTES=30
```

## Jalankan

```bash
npm install
npm start
```

Atau Docker:

```bash
docker build -t ptero-drive-web .
docker run -d --name ptero-drive-web --restart unless-stopped --env-file .env -p 3000:3000 ptero-drive-web
```

## Deploy

Gunakan host yang mendukung proses Node.js **long-running** dan koneksi SSH outbound, misalnya VPS sendiri atau platform container. Vercel/serverless tidak direkomendasikan untuk flow ini karena sesi SSH sementara perlu tetap hidup selama user menyelesaikan OAuth.

## File di VPS target

- `/opt/ptero-drive-backup/backup.sh`
- `/opt/ptero-drive-backup/config.env`
- `/opt/ptero-drive-backup/rclone.conf`
- `/etc/systemd/system/ptero-drive-backup.service`
- `/etc/systemd/system/ptero-drive-backup.timer`
- log: `/var/log/ptero-drive-backup.log`

Cek manual jika diperlukan:

```bash
systemctl status ptero-drive-backup.timer
systemctl status ptero-drive-backup.service
tail -n 100 /var/log/ptero-drive-backup.log
```

## Catatan konsistensi

Ini adalah **hot backup**: file server game dapat berubah saat archive sedang dibaca. Untuk workload/database game yang sangat sensitif terhadap konsistensi, hentikan server game atau buat snapshot filesystem/provider sebelum backup full.
