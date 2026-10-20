// Shared harness for the headless-Chromium scripts: a memory-backed relay,
// the built app (dist/) served with vercel.json headers, and a browser.
// Needs playwright-core (PLAYWRIGHT_CORE=/path/to/playwright-core/index.js or
// resolvable as 'playwright-core') and Chromium (CHROMIUM, default /usr/bin/chromium).
import { spawn } from 'node:child_process';

export async function harness({ relayPort = 8790, appPort = 4180 } = {}) {
  const pw = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core');
  const chromium = pw.chromium || pw.default.chromium;
  const relayUrl = `http://127.0.0.1:${relayPort}`;
  const relay = spawn(process.execPath, [new URL('../../relay/server.js', import.meta.url).pathname], {
    env: { ...process.env, PORT: String(relayPort), RELAY_STORAGE: 'memory', NODE_ENV: '' }, stdio: 'ignore',
  });
  process.env.SERVE_RELAY = relayUrl;
  const { server } = await import('./serve.mjs');
  await new Promise((r) => server.listen(appPort, r));
  for (let i = 0; i < 50; i++) { try { await fetch(relayUrl + '/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const app = `http://127.0.0.1:${appPort}`;
  const close = async () => { await browser.close(); server.close(); relay.kill(); };
  return { browser, app, relayUrl, close };
}

export async function sell(page, app, { title, text, copies = 1, query = '' }) {
  await page.goto(`${app}/${query}#/sell`);
  await page.waitForSelector('.engine.ready', { timeout: 300000 });
  await page.fill('input[maxlength="120"]', title);
  await page.fill('input[inputmode="decimal"]', '0.1');
  await page.fill('input[type="number"]', String(copies));
  await page.fill('textarea.mono', text);
  const t0 = Date.now();
  await page.click('form button.btn');
  await page.waitForFunction(() => /total on this device/.test(document.querySelector('.steps')?.textContent || ''), null, { timeout: 900000 });
  return { ms: Date.now() - t0, note: await page.textContent('.steps li:first-child small') };
}
