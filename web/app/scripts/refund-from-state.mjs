// Broadcast the buyer's pre-signed, time-locked escrow refund from a saved
// browser device state (localStorage `lintel.v1` dump), e.g. after a sale that
// funded the escrow but never settled. Holds no keys itself; the state file it
// reads is SECRET (wallet key, signed refund) — keep it local, never commit it.
//
// Steps: escrow height from the mined funding tx -> wait until the chain tip
// is past the refund's nLockTime -> `lintel-chain finalize` (witness from
// chain, prove, verify) -> broadcast -> wait until mined. Idempotent: if the
// refund txid is already on chain it just reports it.
//
//   STATE=buyer-state.SECRET.json LISTING=<id> LINTEL_CHAIN=path/to/lintel-chain \
//   [RELAY_URL=https://lintel-relay...] [OUT=evidence.json] node scripts/refund-from-state.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const relay = (process.env.RELAY_URL || 'http://localhost:8787').replace(/\/$/, '');
const bin = process.env.LINTEL_CHAIN || 'lintel-chain';
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(p) { const r = await fetch(relay + p); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); }
async function mined(txid) { try { const r = await get(`/chain/tx/${txid}`); return r.mined ? r.height : null; } catch { return null; } }

const state = JSON.parse(fs.readFileSync(process.env.STATE, 'utf8'));
const lid = process.env.LISTING || Object.keys(state.buying || {})[0];
const c = state.buying?.[lid]?.chain;
if (!c?.refundSigned) throw new Error(`no signed refund for listing ${lid} in this state`);
const lockHeight = c.refundTerms?.lock?.lock_height ?? c.E;
const refundTxid = c.refundInfo.txid;
const out = { network: 'testnet', listing_id: lid, funding_txid: c.fund.txid, refund_txid: refundTxid, n_lock_time: lockHeight };

let h = await mined(refundTxid);
if (h) { log('refund already mined at', h); }
else {
  const fundH = await mined(c.fund.txid);
  if (!fundH) throw new Error(`funding ${c.fund.txid} is not mined; there is no escrow to refund`);
  out.funding_height = fundH;
  const escrow = { ...c.escrow, txid: c.fund.txid, height: fundH };
  for (;;) {
    const tip = (await get('/chain/height')).height;
    if (tip > lockHeight) { log('tip', tip, '> lock', lockHeight); break; }
    log('tip', tip, 'waiting for >', lockHeight, `(${lockHeight - tip + 1} blocks)`);
    await sleep(60_000);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lintel-refund-'));
  try {
    fs.writeFileSync(path.join(dir, 'refund.pczt'), Buffer.from(c.refundSigned, 'base64'));
    fs.writeFileSync(path.join(dir, 'escrow.json'), JSON.stringify(escrow));
    const fin = JSON.parse(execFileSync(bin, ['finalize', '--pczt', path.join(dir, 'refund.pczt'), '--note', path.join(dir, 'escrow.json'),
      '--index', String(c.refundInfo.action_index), '--out', path.join(dir, 'refund.hex')], { encoding: 'utf8' }));
    if (fin.txid !== refundTxid) throw new Error(`finalized txid ${fin.txid} != signed refund txid ${refundTxid}`);
    log('finalized', fin.txid, fin.bytes, 'bytes');
    const raw = fs.readFileSync(path.join(dir, 'refund.hex'), 'utf8').trim();
    const b = await (await fetch(relay + '/chain/broadcast', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx: raw }) })).json();
    log('broadcast', JSON.stringify(b));
    if (!b.accepted && !(await mined(refundTxid))) {
      // a lost reply / resend: the node may already hold it in its mempool
      try { await get(`/chain/tx/${refundTxid}`); } catch { throw new Error(`refund rejected: ${b.error_message}`); }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  for (let i = 0; i < 60 && !(h = await mined(refundTxid)); i++) { log('waiting for the refund to be mined'); await sleep(30_000); }
  if (!h) throw new Error('refund broadcast but not mined after 30 min');
}
out.refund_height = h;
out.refund_value_zats = c.refundTerms?.amount;
out.finished = new Date().toISOString();
log('DONE', JSON.stringify(out));
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(out, null, 2) + '\n');
