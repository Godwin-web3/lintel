// Static server for dist/ that applies the same headers as vercel.json
// (CSP, COOP/COEP, caching), so local tests see production isolation.
//   node scripts/serve.mjs [port] [--relay http://127.0.0.1:8787]
// --relay (or SERVE_RELAY) adds that origin to connect-src; production CSP allows https: only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('../dist/', import.meta.url).pathname;
const cfg = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
const port = Number(args.find((a) => /^\d+$/.test(a)) || 4173);
const relay = args.includes('--relay') ? args[args.indexOf('--relay') + 1] : process.env.SERVE_RELAY || null;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.bin': 'application/octet-stream', '.json': 'application/json', '.svg': 'image/svg+xml' };

export function headersFor(urlPath) {
  const out = {};
  for (const rule of cfg.headers) {
    const re = new RegExp('^' + rule.source.replace(/\(\.\*\)/g, '(.*)') + '$');
    if (re.test(urlPath)) for (const h of rule.headers) out[h.key] = h.value;
  }
  if (relay && out['Content-Security-Policy']) out['Content-Security-Policy'] = out['Content-Security-Policy'].replace('connect-src', `connect-src ${relay}`);
  return out;
}

export const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = path.normalize(path.join(root, decodeURIComponent(u.pathname)));
  if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', ...headersFor(u.pathname) });
  fs.createReadStream(p).pipe(res);
});

if (import.meta.url === `file://${process.argv[1]}`) server.listen(port, () => console.log(`dist on http://127.0.0.1:${port}`));
