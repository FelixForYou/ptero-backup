const $ = (s) => document.querySelector(s);
const panels = [...document.querySelectorAll('[data-panel]')];
const navs = [...document.querySelectorAll('[data-step-nav]')];
let jobId = sessionStorage.getItem('ptero_job') || '';
let authUrl = sessionStorage.getItem('ptero_auth_url') || '';

function adminKey() { return sessionStorage.getItem('ptero_admin_key') || ''; }
function showStep(n) {
  panels.forEach((p) => p.classList.toggle('active', p.dataset.panel === String(n)));
  navs.forEach((x) => x.classList.toggle('active', Number(x.dataset.stepNav) <= n));
}
function alertBox(text, type = '') {
  const el = $('#alert');
  el.textContent = text;
  el.className = `alert ${type}`.trim();
  if (!text) el.classList.add('hidden'); else el.classList.remove('hidden');
}
function busy(btn, on, text) {
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.disabled = on;
  btn.textContent = on ? text : btn.dataset.label;
}
async function api(url, options = {}) {
  const headers = { 'content-type': 'application/json', 'x-admin-key': adminKey(), ...(options.headers || {}) };
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

$('#adminKey').value = adminKey();
$('#saveKey').addEventListener('click', () => {
  sessionStorage.setItem('ptero_admin_key', $('#adminKey').value);
  alertBox('Access key disimpan hanya di session browser ini.', 'success');
});

$('#sshForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  sessionStorage.setItem('ptero_admin_key', $('#adminKey').value);
  const btn = $('#connectBtn');
  busy(btn, true, 'Menghubungkan & memasang kebutuhan...');
  alertBox('');
  $('#sshStatus').textContent = 'Menghubungkan';
  try {
    const data = await api('/api/connect', {
      method: 'POST',
      body: JSON.stringify({ host: $('#host').value.trim(), port: Number($('#port').value), username: $('#username').value.trim(), password: $('#password').value })
    });
    jobId = data.jobId; authUrl = data.authUrl;
    sessionStorage.setItem('ptero_job', jobId);
    sessionStorage.setItem('ptero_auth_url', authUrl);
    $('#password').value = '';
    $('#sshStatus').textContent = 'Login berhasil';
    $('#sshStatus').className = 'status success';
    $('#detect').textContent = data.detect || 'VPS terhubung.';
    $('#detect').classList.remove('hidden');
    const hostLine = String(data.detect || '').split('\n').find((x) => x.startsWith('HOST='));
    if (hostLine) $('#hostLabel').value = hostLine.replace('HOST=', '').trim();
    showStep(2);
    alertBox('VPS siap. Sekarang hubungkan Google Drive.', 'success');
  } catch (err) {
    $('#sshStatus').textContent = 'Login gagal';
    $('#sshStatus').className = 'status error';
    alertBox(err.message, 'error');
  } finally { busy(btn, false, ''); }
});

$('#driveBtn').addEventListener('click', () => {
  if (!authUrl) return alertBox('Login VPS dulu.', 'error');
  window.location.href = authUrl;
});

$('#configForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#installBtn');
  busy(btn, true, 'Memasang systemd timer...');
  alertBox('');
  try {
    const data = await api(`/api/job/${encodeURIComponent(jobId)}/configure`, {
      method: 'POST',
      body: JSON.stringify({
        backupScope: $('#backupScope').value,
        schedule: $('#schedule').value,
        retentionDays: Number($('#retentionDays').value),
        remoteDir: $('#remoteDir').value.trim(),
        hostLabel: $('#hostLabel').value.trim(),
        runNow: $('#runNow').checked
      })
    });
    $('#summary').innerHTML = '';
    const rows = [
      ['VPS', data.host], ['Isi backup', data.scope], ['Jadwal', data.schedule], ['Retensi', `${data.retentionDays} hari`],
      ['Folder Drive', data.remotePath], ['Backup pertama', data.runNow ? 'Dijalankan sekarang' : 'Menunggu jadwal'], ['Timer', data.nextRun || 'Aktif']
    ];
    for (const [k, v] of rows) {
      const row = document.createElement('div'); row.className = 'summary-row';
      const a = document.createElement('span'); a.textContent = k;
      const b = document.createElement('b'); b.textContent = v;
      row.append(a, b); $('#summary').append(row);
    }
    sessionStorage.removeItem('ptero_job'); sessionStorage.removeItem('ptero_auth_url');
    showStep(4);
    alertBox('');
  } catch (err) { alertBox(err.message, 'error'); }
  finally { busy(btn, false, ''); }
});

$('#restartBtn').addEventListener('click', () => {
  sessionStorage.removeItem('ptero_job'); sessionStorage.removeItem('ptero_auth_url');
  jobId = ''; authUrl = ''; location.href = '/';
});

async function resume() {
  const params = new URLSearchParams(location.search);
  const oauth = params.get('oauth');
  if (oauth) history.replaceState({}, '', '/');
  if (oauth === 'error') alertBox(`Google OAuth gagal: ${params.get('reason') || 'unknown'}`, 'error');
  if (oauth === 'expired') alertBox('Sesi setup sudah kedaluwarsa. Login VPS lagi.', 'error');
  if (!jobId || !adminKey()) return;
  try {
    const data = await api(`/api/job/${encodeURIComponent(jobId)}`);
    if (data.googleConnected) {
      $('#driveStatus').textContent = 'Terhubung'; $('#driveStatus').className = 'status success';
      showStep(3); alertBox('Google Drive berhasil terhubung.', 'success');
    } else if (oauth === 'success') {
      setTimeout(resume, 800);
    } else {
      showStep(2);
    }
  } catch (err) {
    if (oauth) alertBox(err.message, 'error');
  }
}
resume();
