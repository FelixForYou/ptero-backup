import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectSSH, execSSH, uploadText } from './lib/ssh.js';
import { getGoogleAuthUrl, exchangeGoogleCode } from './lib/google.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').replace(/\/$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${PUBLIC_URL}/oauth/google/callback`;
const JOB_TTL = Math.max(5, Number(process.env.JOB_TTL_MINUTES || 30)) * 60 * 1000;

if (!PUBLIC_URL || !ADMIN_KEY || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('ENV belum lengkap. Isi PUBLIC_URL, ADMIN_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.');
  process.exit(1);
}

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({ windowMs: 60_000, limit: 40, standardHeaders: true, legacyHeaders: false });
app.use('/api', limiter);

const jobs = new Map();

function cleanJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  try { job.conn?.end(); } catch {}
  if (job.timer) clearTimeout(job.timer);
  jobs.delete(id);
}

function touchJob(job) {
  if (job.timer) clearTimeout(job.timer);
  job.timer = setTimeout(() => cleanJob(job.id), JOB_TTL);
}

function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key') || '';
  const a = Buffer.from(key);
  const b = Buffer.from(ADMIN_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Access key web salah.' });
  next();
}
app.use('/api', requireAdmin);

function safeHostLabel(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'pterodactyl';
}
function envQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}
function scheduleToCalendar(schedule) {
  const map = {
    hourly: 'hourly',
    every6h: '*-*-* 00,06,12,18:00:00',
    every12h: '*-*-* 00,12:00:00',
    daily: 'daily'
  };
  return map[schedule] || map.daily;
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/connect', async (req, res) => {
  const { host, port = 22, username = 'root', password } = req.body || {};
  if (!host || !password) return res.status(400).json({ error: 'IP/host dan password wajib diisi.' });
  if (!/^([a-zA-Z0-9.-]{1,253}|\[[0-9a-fA-F:]+\])$/.test(String(host))) return res.status(400).json({ error: 'Format host tidak valid.' });
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) return res.status(400).json({ error: 'Port SSH tidak valid.' });
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(String(username))) return res.status(400).json({ error: 'Username SSH tidak valid.' });

  let conn;
  try {
    conn = await connectSSH({ host, port, username, password });
    const uid = await execSSH(conn, 'id -u', { timeout: 15000 });
    if (uid.stdout.trim() !== '0') throw new Error('Akun SSH harus root agar installer bisa dipasang otomatis.');

    const installScript = await fs.readFile(path.join(__dirname, 'remote', 'install-prereqs.sh'), 'utf8');
    await uploadText(conn, '/tmp/ptero-drive-prereqs.sh', installScript, 0o700);
    await execSSH(conn, 'bash /tmp/ptero-drive-prereqs.sh && rm -f /tmp/ptero-drive-prereqs.sh', { timeout: 360000 });

    const detect = await execSSH(conn, `bash -lc 'printf "HOST="; hostname -s; printf "PANEL="; test -f /var/www/pterodactyl/.env && echo yes || echo no; printf "WINGS="; test -f /etc/pterodactyl/config.yml && echo yes || echo no; printf "VOLUMES="; test -d /var/lib/pterodactyl/volumes && echo yes || echo no'`, { timeout: 15000 });

    const id = crypto.randomUUID();
    const state = crypto.randomBytes(32).toString('hex');
    const job = { id, state, conn, host: String(host), createdAt: Date.now(), google: null, timer: null };
    touchJob(job);
    jobs.set(id, job);

    const authUrl = getGoogleAuthUrl({ clientId: GOOGLE_CLIENT_ID, redirectUri: GOOGLE_REDIRECT_URI, state });
    res.json({ ok: true, jobId: id, authUrl, detect: detect.stdout.trim() });
  } catch (err) {
    try { conn?.end(); } catch {}
    res.status(400).json({ error: err.message || 'Gagal login SSH.' });
  }
});

app.get('/oauth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/?oauth=error&reason=${encodeURIComponent(String(error))}`);
  const job = [...jobs.values()].find((x) => x.state === state);
  if (!job || !code) return res.redirect('/?oauth=expired');
  try {
    touchJob(job);
    const token = await exchangeGoogleCode({
      code: String(code),
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      redirectUri: GOOGLE_REDIRECT_URI
    });
    job.google = token;
    res.redirect('/?oauth=success');
  } catch (err) {
    res.redirect(`/?oauth=error&reason=${encodeURIComponent(err.message || 'oauth_failed')}`);
  }
});

app.get('/api/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Sesi setup sudah kedaluwarsa. Login VPS lagi.' });
  touchJob(job);
  res.json({ ok: true, googleConnected: Boolean(job.google), host: job.host });
});

app.post('/api/job/:id/configure', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Sesi setup sudah kedaluwarsa. Login VPS lagi.' });
  if (!job.google) return res.status(400).json({ error: 'Google Drive belum dihubungkan.' });
  touchJob(job);

  const schedule = ['hourly', 'every6h', 'every12h', 'daily'].includes(req.body.schedule) ? req.body.schedule : 'daily';
  const backupScope = ['panel', 'servers', 'full'].includes(req.body.backupScope) ? req.body.backupScope : 'full';
  const retentionDays = Math.min(365, Math.max(1, Number(req.body.retentionDays || 7)));
  const remoteDir = safeHostLabel(req.body.remoteDir || 'PterodactylBackups');
  const hostLabel = safeHostLabel(req.body.hostLabel || job.host);
  const runNow = Boolean(req.body.runNow);

  try {
    const expiry = new Date(Date.now() + Number(job.google.expires_in || 3600) * 1000).toISOString();
    const rcloneToken = JSON.stringify({
      access_token: job.google.access_token,
      token_type: job.google.token_type || 'Bearer',
      refresh_token: job.google.refresh_token,
      expiry
    });

    const rcloneConf = [
      '[ptero-drive]',
      'type = drive',
      `client_id = ${GOOGLE_CLIENT_ID}`,
      `client_secret = ${GOOGLE_CLIENT_SECRET}`,
      'scope = drive.file',
      `token = ${rcloneToken}`,
      ''
    ].join('\n');

    const configEnv = [
      `PANEL_DIR=${envQuote('/var/www/pterodactyl')}`,
      `REMOTE_NAME=${envQuote('ptero-drive')}`,
      `REMOTE_DIR=${envQuote(remoteDir)}`,
      `BACKUP_SCOPE=${envQuote(backupScope)}`,
      `RETENTION_DAYS=${envQuote(String(retentionDays))}`,
      `HOST_LABEL=${envQuote(hostLabel)}`,
      ''
    ].join('\n');

    const service = `[Unit]\nDescription=Pterodactyl Google Drive Backup\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=oneshot\nExecStart=/opt/ptero-drive-backup/backup.sh\nNice=10\nIOSchedulingClass=best-effort\nIOSchedulingPriority=7\n`;
    const onCalendar = scheduleToCalendar(schedule);
    const timer = `[Unit]\nDescription=Schedule Pterodactyl Google Drive Backup\n\n[Timer]\nOnCalendar=${onCalendar}\nPersistent=true\nRandomizedDelaySec=120\nUnit=ptero-drive-backup.service\n\n[Install]\nWantedBy=timers.target\n`;

    const backupScript = await fs.readFile(path.join(__dirname, 'remote', 'backup.sh'), 'utf8');
    await uploadText(job.conn, '/opt/ptero-drive-backup/backup.sh', backupScript, 0o700);
    await uploadText(job.conn, '/opt/ptero-drive-backup/rclone.conf', rcloneConf, 0o600);
    await uploadText(job.conn, '/opt/ptero-drive-backup/config.env', configEnv, 0o600);
    await uploadText(job.conn, '/etc/systemd/system/ptero-drive-backup.service', service, 0o644);
    await uploadText(job.conn, '/etc/systemd/system/ptero-drive-backup.timer', timer, 0o644);

    await execSSH(job.conn, `bash -lc 'chmod 700 /opt/ptero-drive-backup/backup.sh; chmod 600 /opt/ptero-drive-backup/rclone.conf /opt/ptero-drive-backup/config.env; rclone --config=/opt/ptero-drive-backup/rclone.conf mkdir ptero-drive:${remoteDir}/${hostLabel}; systemctl daemon-reload; systemctl enable --now ptero-drive-backup.timer; systemctl restart ptero-drive-backup.timer; systemctl is-active ptero-drive-backup.timer'`, { timeout: 120000 });

    if (runNow) {
      await execSSH(job.conn, `systemctl start --no-block ptero-drive-backup.service`, { timeout: 15000 });
    }

    const next = await execSSH(job.conn, `systemctl list-timers ptero-drive-backup.timer --no-pager --all | tail -n +2 | head -n 1 || true`, { timeout: 15000 });
    const result = {
      ok: true,
      message: 'Backup otomatis berhasil dipasang.',
      host: job.host,
      scope: backupScope,
      schedule,
      retentionDays,
      remotePath: `${remoteDir}/${hostLabel}`,
      nextRun: next.stdout.trim(),
      runNow
    };

    // Hapus token/password setup dari memori setelah instalasi selesai.
    setTimeout(() => cleanJob(job.id), 2000);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Gagal memasang backup.' });
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => console.log(`Ptero Drive Web listening on :${PORT}`));
