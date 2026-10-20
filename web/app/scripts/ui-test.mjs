// UI end-to-end in headless Chromium against the built app (dist/):
// 1. Seller lists 2 copies, then closes the browser (offline).
// 2. Two buyers each buy a copy and are told to wait for the seller.
// 3. Seller reopens the app on the Market page (not "My sales"); the
//    background agent completes both sales.
// 4. Both buyers unlock the content, after a reload (state resumes).
//   npm run build && PLAYWRIGHT_CORE=... node scripts/ui-test.mjs
import { harness, sell } from './harness.mjs';

const secret = 'UI-E2E secret: '.padEnd(2400, '#') + ' END'; // 2 proof parts
const { browser, app, relayUrl, close } = await harness({ relayPort: 8791, appPort: 4181 });
const ok = (c, m) => { if (!c) throw new Error('FAILED: ' + m); console.log('ok -', m); };
try {
  const sellerCtx = await browser.newContext();
  const sp = await sellerCtx.newPage();
  sp.on('pageerror', (e) => console.error('seller pageerror', e.message));
  const s = await sell(sp, app, { title: 'UI test report', text: secret, copies: 2 });
  console.log('seller sealed 2 copies:', s.ms, 'ms');
  const state = await sp.evaluate(() => localStorage.getItem('lintel.v1'));
  await sp.close(); // seller offline (storage kept in its context)

  const { listings } = await (await fetch(relayUrl + '/listings')).json();
  const lid = listings.find((l) => l.title === 'UI test report').id;
  ok(listings.find((l) => l.id === lid).units_open === 2, 'listing shows 2 open copies');

  const buyers = [];
  for (const name of ['A', 'B']) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    p.on('pageerror', (e) => console.error(`buyer ${name} pageerror`, e.message));
    await p.goto(`${app}/#/listing/${lid}`);
    await p.waitForSelector('.proof.ok', { timeout: 300000 });
    await p.click('text=Buy a copy');
    await p.waitForSelector('text=Waiting for the seller', { timeout: 300000 });
    buyers.push({ name, ctx, p });
  }
  ok(true, 'both buyers ordered while the seller was offline');
  const mid = await (await fetch(`${relayUrl}/listings/${lid}/orders`)).json();
  ok(mid.orders.length === 2 && mid.orders.every((o) => o.status === 'awaiting_seller'), 'relay holds 2 orders awaiting the seller');
  const dump = JSON.stringify(mid) + JSON.stringify(await (await fetch(`${relayUrl}/listings/${lid}`)).json());
  const seller = JSON.parse(state).selling[lid];
  const leaked = Object.values(seller.units).some((u) => Object.values(JSON.parse(u.secret)).some((v) => dump.includes(v)));
  ok(!leaked && !dump.includes('UI-E2E secret'), 'relay never saw unit secrets or plaintext');

  // Seller comes back on the Market page only.
  const sp2 = await sellerCtx.newPage();
  await sp2.goto(`${app}/#/`);
  await sp2.waitForSelector('.engine.ready', { timeout: 300000 });
  for (let i = 0; i < 60; i++) {
    const { orders } = await (await fetch(`${relayUrl}/listings/${lid}/orders`)).json();
    if (orders.every((o) => o.status === 'complete')) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const done = await (await fetch(`${relayUrl}/listings/${lid}`)).json();
  ok(done.listing.status === 'sold' && done.listing.units_sold === 2, 'seller agent completed both sales from the Market page');

  for (const b of buyers) {
    await b.p.reload();
    await b.p.waitForSelector('.unlocked pre', { timeout: 300000 });
    const text = await b.p.textContent('.unlocked pre');
    ok(text === secret, `buyer ${b.name} unlocked the exact content after reload`);
  }
  console.log('UI E2E PASSED');
} catch (e) {
  console.error(e.message); process.exitCode = 1;
} finally { await close(); }
