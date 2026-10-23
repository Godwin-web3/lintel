// Starts the repo's relay (web/relay/server.js) on a free port with memory
// storage, unless LINTEL_RELAY_URL points at one already running.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const RELAY = fileURLToPath(new URL('../../../web/relay/server.js', import.meta.url));

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

export async function startRelay() {
  if (process.env.LINTEL_RELAY_URL) return { url: process.env.LINTEL_RELAY_URL, stop: async () => {} };
  const port = await freePort();
  const child = spawn(process.execPath, [RELAY], {
    env: { ...process.env, PORT: String(port), RELAY_STORAGE: 'memory', NODE_ENV: '' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(url + '/health'); if (r.ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { url, stop: async () => { child.kill(); await new Promise((r) => child.once('exit', r)); } };
}
