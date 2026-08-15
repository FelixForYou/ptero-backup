import { Client } from 'ssh2';

export function connectSSH({ host, port = 22, username = 'root', password }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        conn.end();
        reject(new Error('Timeout saat menghubungkan SSH.'));
      }
    }, 15000);

    conn
      .on('ready', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(conn);
      })
      .on('error', (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      })
      .connect({
        host,
        port: Number(port),
        username,
        password,
        readyTimeout: 12000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        algorithms: {
          serverHostKey: ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']
        }
      });
  });
}

export function execSSH(conn, command, { timeout = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { stream.close(); } catch {}
        reject(new Error('Perintah SSH timeout.'));
      }, timeout);

      stream.on('data', (d) => { stdout += d.toString(); });
      stream.stderr.on('data', (d) => { stderr += d.toString(); });
      stream.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve({ stdout, stderr, code, signal });
        else reject(Object.assign(new Error(stderr.trim() || stdout.trim() || `Command gagal (${code})`), { stdout, stderr, code, signal }));
      });
    });
  });
}

export function uploadText(conn, remotePath, content, mode = 0o600) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const stream = sftp.createWriteStream(remotePath, { mode });
      stream.on('error', reject);
      stream.on('close', () => resolve());
      stream.end(content);
    });
  });
}
