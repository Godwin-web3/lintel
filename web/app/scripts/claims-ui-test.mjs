// Proven claims end to end in headless Chromium against the built app (dist/):
// 1. The seller lists one copy of a short text with two claims (a prefix and
//    length bounds). Claims force offer v3, so this proves one big part in
//    single-threaded WASM (minutes).
// 2. A buyer opens the listing: the proof verifies on the device and the
//    claims appear in plain English under "Also proven about that content".
//   npm run build && PLAYWRIGHT_CORE=... node scripts/claims-ui-test.mjs
import { harness } from './harness.mjs';

const text = '%PDF-1.7 claims UI test '.padEnd(3000, '.') + ' END';
const { browser, app, relayUrl, close } = await harness({ appPort: 4182 });
const ok = (c, m) => { if (!c) throw new Error('FAILED: ' + m); console.log('ok -', m); };
try {
  const sp = await (await browser.newContext()).newPage();
  sp.on('pageerror', (e) => console.error('seller pageerror', e.message));
  await sp.goto(`${app}/#/sell`);
  await sp.waitForSelector('.engine.ready', { timeout: 300000 });
  await sp.fill('input[maxlength="120"]', 'Claims UI test');
  await sp.fill('input[inputmode="decimal"]', '0.1');
  await sp.fill('textarea.mono', text);
  await sp.fill('input[placeholder^="%PDF"]', '%PDF-');
  await sp.fill('input[placeholder="1000"]', '2000');
  await sp.fill('input[placeholder="25000"]', '4000');
  await sp.waitForFunction(() => /Starts with "%PDF-"/.test(document.querySelector('.claims-edit')?.textContent || ''), null, { timeout: 60000 });
  ok(/Length between 2,000 and 4,000 bytes/.test(await sp.textContent('.claims-edit')), 'seller preview shows both claims');
  // A false claim is caught before sealing and blocks the button.
  await sp.fill('input[placeholder^="%PDF"]', 'PK');
  await sp.waitForFunction(() => /does not hold/.test(document.querySelector('.claims-edit')?.textContent || ''), null, { timeout: 60000 });
  ok(await sp.isDisabled('form button.btn'), 'false claim blocks listing');
  await sp.fill('input[placeholder^="%PDF"]', '%PDF-');
  await sp.waitForFunction(() => /Starts with "%PDF-"/.test(document.querySelector('.claims-edit')?.textContent || ''), null, { timeout: 60000 });
  const t0 = Date.now();
  await sp.click('form button.btn');
  await sp.waitForFunction(() => /total on this device/.test(document.querySelector('.steps')?.textContent || ''), null, { timeout: 1800000 });
  console.log('sealed with claims in', Date.now() - t0, 'ms');

  const { listings } = await (await fetch(relayUrl + '/listings')).json();
  const lid = listings.find((l) => l.title === 'Claims UI test').id;
  const bp = await (await browser.newContext()).newPage();
  bp.on('pageerror', (e) => console.error('buyer pageerror', e.message));
  await bp.goto(`${app}/#/listing/${lid}`);
  await bp.waitForSelector('.proof.ok, .proof.bad', { timeout: 600000 });
  const proof = await bp.textContent('.proof');
  ok(/Proof verified/.test(proof), 'buyer verified the proof');
  ok(/Also proven about that content/.test(proof) && /Starts with "%PDF-"/.test(proof) && /Length between 2,000 and 4,000 bytes/.test(proof), 'buyer sees the proven claims');
  console.log('PASS');
} finally {
  await close();
}
