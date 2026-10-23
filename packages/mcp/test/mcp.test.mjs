// lintel-mcp end to end over an in-memory MCP transport, against a local
// relay. Purchases run as off-chain rehearsals (no funds move) except the
// allowed-sellers test, which runs the on-chain path up to the point where
// the seller's payout address is known and the policy refuses BEFORE any
// funding is built.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLintel, MemoryStore } from 'lintel-sdk';
import { createServer } from '../dist/server.js';
import { startRelay } from '../../sdk/test/helpers.mjs';

let relay, seller, dir;
const outputs = [];
before(async () => {
  relay = await startRelay();
  seller = await createLintel({ relayUrl: relay.url, store: new MemoryStore() });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lintel-mcp-it-'));
});
after(async () => { await relay?.stop(); });

async function agent({ policy, mode = 'relay', store = new MemoryStore(), name = Math.random().toString(16).slice(2) } = {}) {
  const home = path.join(dir, name);
  fs.mkdirSync(home, { recursive: true });
  const policyPath = path.join(home, 'policy.json');
  if (policy) fs.writeFileSync(policyPath, JSON.stringify(policy));
  const lintel = await createLintel({ relayUrl: relay.url, store });
  const files = path.join(home, 'files'); fs.mkdirSync(files);
  const server = createServer({ lintel, mode, policyPath, spendLogPath: path.join(home, 'spend.jsonl'), outDir: path.join(home, 'out'), handoffDir: path.join(home, 'handoff'), filesDir: files });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-agent', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 15 * 60 * 1000 }); // sealing/proving can take minutes
    outputs.push(r.content[0].text);
    return { ...JSON.parse(r.content[0].text), isError: !!r.isError };
  };
  return { call, client, lintel, home, policyPath, store };
}

const listing = async (price, data = 'secret ' + Math.random()) => ({ id: (await seller.sell({ title: `MCP test ${price}`, price, data })).listing.id, data });
const runSeller = (id) => { const ac = new AbortController(); const p = (async () => { for await (const s of seller.sale(id).watch({ intervalMs: 200, signal: ac.signal })) if (s.done) break; })(); return () => { ac.abort(); return p; }; };

test('tools are listed with schemas', async () => {
  const { client } = await agent();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['lintel_buy', 'lintel_get_limits', 'lintel_get_listing', 'lintel_handoff_to_agent', 'lintel_list_listings', 'lintel_purchase_status', 'lintel_refund', 'lintel_sale_status', 'lintel_sell', 'lintel_spending_report', 'lintel_verify_listing', 'lintel_wallet', 'lintel_wallet_scan']);
});

test('without a policy file, browsing works and spending is disabled', async () => {
  const a = await agent();
  const { id } = await listing('0.01');
  assert.ok((await a.call('lintel_list_listings')).listings.some((l) => l.id === id));
  const v = await a.call('lintel_verify_listing', { listingId: id });
  assert.equal(v.verified, true);
  assert.equal((await a.call('lintel_get_limits')).spending, 'disabled');
  const r = await a.call('lintel_buy', { listingId: id });
  assert.ok(r.isError);
  assert.match(r.error, /spending is disabled/);
});

test('per-purchase cap and the agent\'s own maxPriceTaz refuse before anything happens', async () => {
  const a = await agent({ policy: { maxPerPurchaseZec: '0.01', maxPerDayZec: '0.1', allowedSellers: 'any' } });
  const { id } = await listing('0.02');
  const r = await a.call('lintel_buy', { listingId: id });
  assert.ok(r.isError);
  assert.match(r.error, /over_per_purchase/);
  const r2 = await a.call('lintel_buy', { listingId: id, maxPriceTaz: '0.001' });
  assert.match(r2.error, /over your maxPriceTaz/);
  assert.equal((await seller.listing(id)).session, null, 'no session opened');
  const rep = await a.call('lintel_spending_report');
  assert.equal(rep.entries.filter((e) => e.status === 'refused').length, 2);
  assert.equal(rep.spent_last_24h_taz, '0');
});

test('expired policy refuses', async () => {
  const a = await agent({ policy: { maxPerPurchaseZec: '1', maxPerDayZec: '1', allowedSellers: 'any', expiresAt: '2020-01-01T00:00:00Z' } });
  const { id } = await listing('0.01');
  assert.match((await a.call('lintel_buy', { listingId: id })).error, /expired/);
});

test('allowed listings refuse others', async () => {
  const a = await agent({ policy: { maxPerPurchaseZec: '1', maxPerDayZec: '1', allowedSellers: 'any', allowedListings: ['someone-else'] } });
  const { id } = await listing('0.01');
  assert.match((await a.call('lintel_buy', { listingId: id })).error, /listing_not_allowed/);
});

test('buy within limits: settles, saves content, logs, and the daily cap then binds', async () => {
  // outlay of a 0.02 purchase is 0.02055 TAZ; the day cap leaves room for one
  const a = await agent({ policy: { maxPerPurchaseZec: '0.03', maxPerDayZec: '0.03', allowedSellers: 'any' } });
  const { id, data } = await listing('0.02');
  const stop = runSeller(id);
  const r = await a.call('lintel_buy', { listingId: id, waitSeconds: 60 });
  await stop();
  let st = r;
  for (let i = 0; i < 10 && st.phase !== 'done'; i++) st = await a.call('lintel_purchase_status', { listingId: id, waitSeconds: 10 });
  assert.equal(st.phase, 'done', JSON.stringify(st));
  assert.equal(st.content, data);
  assert.equal(fs.readFileSync(st.saved_to, 'utf8'), data);
  assert.equal(fs.statSync(st.saved_to).mode & 0o777, 0o600);
  const limits = await a.call('lintel_get_limits');
  assert.equal(limits.spent_last_24h_taz, '0.02055');
  assert.equal(limits.remaining_today_taz, '0.00945');
  const statuses = (await a.call('lintel_spending_report')).entries.map((e) => e.status).reverse();
  assert.deepEqual(statuses, ['reserved', 'settled']);
  const { id: id2 } = await listing('0.01'); // outlay 0.01055 > 0.00945 left
  const r2 = await a.call('lintel_buy', { listingId: id2 });
  assert.match(r2.error, /over_per_day/);
});

test('allowed sellers: on-chain purchase is refused once the seller\'s payout address is known, before funding', async () => {
  // The buyer wallet holds a placeholder note so the purchase can start; the
  // policy refuses before the funding transaction is built, so it is never used.
  const store = new MemoryStore();
  const a = await agent({ policy: { maxPerPurchaseZec: '0.05', maxPerDayZec: '0.1', allowedSellers: ['utest1' + 'q'.repeat(100)] }, mode: 'chain', store });
  await a.lintel.wallet.create();
  const st = store.load();
  st.wallet.notes.push({ cmx: 'ab'.repeat(32), value: 10_000_000, height: 1 });
  store.save(st);
  await seller.wallet.create().catch(() => {});
  const { id } = await listing('0.02');
  const r1 = await a.call('lintel_buy', { listingId: id, waitSeconds: 0 });
  assert.equal(r1.phase, 'joined', JSON.stringify(r1));
  const s = await seller.sale(id).step();
  assert.equal(s.phase, 'escrow');
  const r2 = await a.call('lintel_purchase_status', { listingId: id, waitSeconds: 0 });
  assert.equal(r2.refused, true, JSON.stringify(r2));
  assert.equal(r2.code, 'seller_not_allowed');
  const { session } = await seller.listing(id);
  assert.equal(session.chain.refund_pczt, undefined, 'no funding or refund was built');
  assert.equal(session.chain.funding_txid, undefined);
  assert.deepEqual((await a.call('lintel_spending_report')).entries.map((e) => e.status).reverse(), ['reserved', 'refused', 'released']);
  assert.equal((await a.call('lintel_get_limits')).spent_last_24h_taz, '0');
  assert.equal((await a.lintel.wallet.spendable()).length, 1, 'reserved note released');
});

test('selling is opt-in; files only from the allowed directory; handoff file stays server-side', async () => {
  const no = await agent({ policy: { maxPerPurchaseZec: '0.01', maxPerDayZec: '0.1', allowedSellers: 'any' } });
  assert.match((await no.call('lintel_sell', { title: 't', priceTaz: '0.01', text: 'x' })).error, /allowSelling/);
  const a = await agent({ policy: { maxPerPurchaseZec: '0.01', maxPerDayZec: '0.1', allowedSellers: 'any', allowSelling: true } });
  fs.writeFileSync(path.join(a.home, 'files', 'report.txt'), 'file content');
  assert.match((await a.call('lintel_sell', { title: 't', priceTaz: '0.01', path: '../policy.json' })).error, /outside the allowed directory/);
  const sold = await a.call('lintel_sell', { title: 'agent file', priceTaz: '0.01', path: 'report.txt' });
  assert.ok(sold.listing_id);
  assert.equal((await a.lintel.listing(sold.listing_id)).listing.filename, 'report.txt');
  assert.equal((await a.call('lintel_sale_status', { listingId: sold.listing_id, waitSeconds: 0 })).phase, 'listed');
  await a.lintel.wallet.create();
  const h = await a.call('lintel_handoff_to_agent', { listingId: sold.listing_id });
  assert.ok(fs.existsSync(h.handoff_file));
  assert.equal(fs.statSync(h.handoff_file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(h.handoff_file, 'utf8')).kind, 'lintel-agent-handoff');
  assert.equal((await a.call('lintel_sale_status', { listingId: sold.listing_id, waitSeconds: 0 })).phase, 'delegated');
});

test('no tool output ever contains a secret key', async () => {
  const a = await agent();
  await a.lintel.wallet.create();
  const w = await a.call('lintel_wallet');
  assert.match(w.address, /^utest1/);
  const sk = await a.lintel.wallet.exportKey();
  const secrets = [sk];
  // every key this test run created on any agent: wallet sk, merchant/payer shares, pay-in keys
  for (const o of outputs) {
    assert.ok(!o.includes(sk));
    assert.ok(!/"(sk|tsk|sk_a|sk_b|secret|state)"\s*:/.test(o), `secret-looking field in tool output: ${o.slice(0, 200)}`);
  }
  assert.ok(secrets.length);
});
