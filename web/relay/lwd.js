// Minimal lightwalletd (gRPC over HTTP/2) client for the relay's public chain
// proxy. Only PUBLIC data passes through here: block heights, commitment
// trees, note commitments, mined transactions, and fully signed transactions
// to broadcast. Nothing here can decrypt, sign or spend.
import http2 from 'node:http2';

export class LwdError extends Error {
  constructor(msg, code = 502) { super(msg); this.code = code; }
}

export const LWD = process.env.LINTEL_LWD || 'https://testnet.zec.rocks:443';
const SVC = '/cash.z.wallet.sdk.rpc.CompactTxStreamer/';
export const POOL_IRONWOOD = 4;

// ---- protobuf (just enough) ----
export function varint(n) { const out = []; while (n > 127) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); return Buffer.from(out); }
export function readVarint(b, i) { let n = 0, mul = 1, x; do { if (i >= b.length) throw new Error('truncated varint'); x = b[i++]; n += (x & 127) * mul; mul *= 128; } while (x & 128); return [n, i]; }
const fBytes = (field, buf) => Buffer.concat([varint(field * 8 + 2), varint(buf.length), buf]);
const fVarint = (field, n) => Buffer.concat([varint(field * 8), varint(n)]);

/** Decodes one protobuf message into { field: [values] } (bytes as Buffer, varints as Number). */
export function decodeFields(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const [key, j] = readVarint(buf, i); i = j;
    const field = Math.floor(key / 8), wire = key & 7;
    let v;
    if (wire === 2) { const [len, k] = readVarint(buf, i); i = k; if (i + len > buf.length) throw new Error('truncated field'); v = buf.subarray(i, i + len); i += len; }
    else if (wire === 0) { const [n, k] = readVarint(buf, i); i = k; v = n; }
    else if (wire === 1) { v = buf.subarray(i, i + 8); i += 8; }
    else if (wire === 5) { v = buf.subarray(i, i + 4); i += 4; }
    else throw new Error('unexpected protobuf wire type');
    (out[field] ??= []).push(v);
  }
  return out;
}

export function decodeRawTransaction(buf) {
  const f = decodeFields(buf);
  return { data: f[1]?.[0] ?? null, height: f[2]?.[0] ?? 0 };
}
export function decodeTreeState(buf) {
  const f = decodeFields(buf);
  const s = (n) => (f[n]?.[0] ? f[n][0].toString('utf8') : '');
  return { network: s(1), height: f[2]?.[0] ?? 0, hash: s(3), ironwood_tree: s(7) };
}
/** Ironwood note commitments of one CompactBlock, in block order. */
export function decodeCompactBlockCmxs(buf) {
  const b = decodeFields(buf);
  const vtx = (b[7] || []).map((t) => decodeFields(t)).map((t) => ({ index: t[1]?.[0] ?? 0, actions: t[9] || [] }));
  vtx.sort((x, y) => x.index - y.index);
  const cmxs = [];
  for (const t of vtx) for (const a of t.actions) {
    const cmx = decodeFields(a)[2]?.[0];
    if (!cmx || cmx.length !== 32) throw new Error('bad cmx in compact block');
    cmxs.push(cmx.toString('hex'));
  }
  return { height: b[2]?.[0] ?? 0, cmxs };
}
export function decodeSendResponse(buf) {
  const f = decodeFields(buf);
  let code = f[1]?.[0] ?? 0;
  if (code > 0x7fffffff) code -= 2 ** 64; // int32 negative values are sign-extended varints
  return { error_code: code, error_message: f[2]?.[0] ? f[2][0].toString('utf8') : '' };
}

// ---- gRPC transport ----
function frame(msg) {
  const f = Buffer.concat([Buffer.alloc(5), msg]);
  f.writeUInt32BE(msg.length, 1);
  return f;
}
function unframe(b) {
  const out = [];
  let i = 0;
  while (i + 5 <= b.length) { const n = b.readUInt32BE(i + 1); out.push(b.subarray(i + 5, i + 5 + n)); i += 5 + n; }
  return out;
}

/** One gRPC call; returns every response message (unary: one; streaming: many). */
export function grpc(method, msg, { lwd = LWD, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const c = http2.connect(lwd);
    let settled = false;
    const done = (e, v) => { if (settled) return; settled = true; c.close(); e ? reject(e) : resolve(v); };
    c.on('error', (e) => done(new LwdError(`lightwalletd: ${e.message}`)));
    const req = c.request({ ':method': 'POST', ':path': SVC + method, 'content-type': 'application/grpc', te: 'trailers' });
    const chunks = []; let status = null, message = '';
    req.setTimeout(timeoutMs, () => { req.close(); done(new LwdError('lightwalletd timeout', 504)); });
    req.on('response', (h) => { if (h['grpc-status'] !== undefined) { status = h['grpc-status']; message = h['grpc-message'] || ''; } });
    req.on('trailers', (t) => { status = t['grpc-status']; message = t['grpc-message'] || ''; });
    req.on('data', (d) => chunks.push(d));
    req.on('error', (e) => done(new LwdError(`lightwalletd: ${e.message}`)));
    req.on('end', () => {
      if (status !== null && status !== undefined && String(status) !== '0') {
        return done(new LwdError(`lightwalletd: ${decodeURIComponent(message) || 'error ' + status}`, 404));
      }
      done(null, unframe(Buffer.concat(chunks)));
    });
    req.end(frame(msg));
  });
}

// ---- calls ----
export async function latestHeight(opts) {
  const [m] = await grpc('GetLatestBlock', Buffer.alloc(0), opts);
  if (!m) throw new LwdError('no block');
  return decodeFields(m)[1]?.[0] ?? 0;
}
export async function rawTx(txidHex, opts) {
  const hash = Buffer.from(txidHex, 'hex').reverse(); // display -> protocol byte order
  const [m] = await grpc('GetTransaction', fBytes(3, hash), opts);
  if (!m) throw new LwdError('transaction not found', 404);
  const { data, height } = decodeRawTransaction(m);
  if (!data) throw new LwdError('transaction not found', 404);
  return { txid: txidHex, height, mined: height > 0 && height < 0xffffffff, data: data.toString('hex') };
}
export async function treeState(height, opts) {
  const [m] = await grpc('GetTreeState', fVarint(1, height), opts);
  if (!m) throw new LwdError('no tree state', 404);
  return decodeTreeState(m);
}
export async function blockCmxs(height, opts) {
  const id = fVarint(1, height);
  const q = Buffer.concat([fBytes(1, id), fBytes(2, id), fVarint(3, POOL_IRONWOOD)]);
  const msgs = await grpc('GetBlockRange', q, opts);
  if (!msgs.length) throw new LwdError('block not found', 404);
  const cmxs = [];
  for (const m of msgs) cmxs.push(...decodeCompactBlockCmxs(m).cmxs);
  return { height, cmxs };
}
export async function sendTx(rawHex, opts) {
  const [m] = await grpc('SendTransaction', fBytes(1, Buffer.from(rawHex, 'hex')), opts);
  if (!m) throw new LwdError('no response');
  return decodeSendResponse(m);
}
