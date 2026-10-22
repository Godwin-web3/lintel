// LIVE check of the app's "Pay from another wallet" code on Zcash testnet,
// without a browser: bundles src/onchain.js as-is (esbuild) with a shim for
// src/api.js that runs the SAME wasm32 on-chain engine the app ships
// (src/pkg-chain, built by `npm run wasm:chain`) in-process, talks to a real
// relay, and keeps device storage in a local JSON file.
//
//   node scripts/payin-live.mjs open  <state.json> <listing-id> <price TAZ>  # payin.open: keys + ZIP 321 request
//   node scripts/payin-live.mjs scan  <state.json> <listing-id>              # payin.scan: what the app sees
//   node scripts/payin-live.mjs withdraw <state.json> <listing-id> <dest>    # payin.withdraw: build in WASM, broadcast
//
// RELAY (default http://127.0.0.1:8787). The state file holds SECRET keys
// (like the browser's localStorage): keep it out of git.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const [cmd, stateFile, lid, arg] = process.argv.slice(2);
const RELAY = process.env.RELAY || 'http://127.0.0.1:8787';

const shim = `
import * as C from ${JSON.stringify(path.join(here, '../src/pkg-chain/lintel_chain.js'))};
import fs from 'node:fs';
const bytes = fs.readFileSync(${JSON.stringify(path.join(here, '../src/pkg-chain/lintel_chain_bg.wasm'))});
C.initSync({ module: bytes });
const FILE = ${JSON.stringify(path.resolve(stateFile || 'state.json'))};
export async function crypto(op, { fn, args } = {}) {
  if (op !== 'chain') throw new Error('shim: only chain ops ' + op);
  if (!/^chain[A-Z]\\w*$/.test(fn) || typeof C[fn] !== 'function') throw new Error('unknown chain function ' + fn);
  return C[fn](...(args || []));
}
export async function relay(method, p, body) {
  // Node's fetch can reuse a keep-alive socket the relay already closed while
  // the WASM was proving; retry once on a network error (requests here are idempotent).
  let r;
  try { r = await doFetch(method, p, body); } catch { r = await doFetch(method, p, body); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'relay error ' + r.status);
  return j;
}
function doFetch(method, p, body) {
  return fetch(${JSON.stringify(RELAY)} + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
}
export const store = {
  get() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { selling: {}, buying: {} }; } },
  put(fn) { const s = store.get(); fn(s); fs.writeFileSync(FILE, JSON.stringify(s), { mode: 0o600 }); return s; },
};
export const randomHex = (n) => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
`;
const out = path.join(here, '.payin-live.bundle.mjs');
await esbuild.build({
  entryPoints: [path.join(here, '../src/onchain.js')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error',
  plugins: [{ name: 'api-shim', setup(b) {
    b.onResolve({ filter: /\/api\.js$/ }, () => ({ path: 'api-shim', namespace: 'shim' }));
    b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: shim, loader: 'js', resolveDir: here }));
  } }],
});
const { payin, fmtZec } = await import(out + '?' + Date.now());
fs.unlinkSync(out);

const pub = (p) => { const { sk, tsk, ...rest } = p; return rest; }; // never print keys
if (cmd === 'open') {
  const p = await payin.open({ id: lid, price_zec: arg, title: `pay-in check ${lid}` });
  console.log(JSON.stringify({ opened: pub(p) }, null, 2));
} else if (cmd === 'scan') {
  const st = await payin.scan(lid);
  const p = payin.get(lid);
  console.log(JSON.stringify({ status: { paid: st.paid, have: st.have, need: st.need, scanned: st.scanned, note: st.note, sel: st.sel },
    notes: p.notes.map(({ rho, rseed, ...n }) => n), utxos: p.utxos, balance: payin.balance(lid), balance_taz: fmtZec(payin.balance(lid)) }, null, 2));
} else if (cmd === 'withdraw') {
  const r = await payin.withdraw(lid, arg);
  console.log(JSON.stringify({ withdraw: r }, null, 2));
} else {
  console.error('usage: payin-live.mjs (open|scan|withdraw) <state.json> <listing-id> [price|dest]');
  process.exit(2);
}
