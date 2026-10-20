// Headless Chromium benchmark of the built app (dist/): boots single-threaded
// (?threads=0) and multithreaded (auto), seals one copy through the real Sell
// form, and reports boot and seal (prove) times.
//   npm run build && PLAYWRIGHT_CORE=... node scripts/bench.mjs
// BENCH_SIZES (bytes, default 1000,3000) and BENCH_RUNS (default 2).
import { harness, sell } from './harness.mjs';

const { browser, app, close } = await harness();
const sizes = (process.env.BENCH_SIZES || '1000,3000').split(',').map(Number);
const runs = Number(process.env.BENCH_RUNS || 2);
const out = [];
try {
  for (const query of ['?threads=0', '']) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('pageerror', e.message));
    page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.error('console', m.text()); });
    const t0 = Date.now();
    await page.goto(`${app}/${query}#/`);
    await page.waitForSelector('.engine.ready', { timeout: 300000 });
    const boot = { query: query || 'auto', engine: (await page.textContent('.engine')).trim(), isolated: await page.evaluate(() => self.crossOriginIsolated), boot_ms: Date.now() - t0, cores: await page.evaluate(() => navigator.hardwareConcurrency) };
    console.log(JSON.stringify(boot));
    for (const size of sizes) for (let r = 0; r < runs; r++) {
      const s = await sell(page, app, { title: `bench ${size} ${r}`, text: 'x'.repeat(size), query });
      const row = { ...boot, size, run: r, seal_ms: s.ms, note: s.note };
      out.push(row); console.log(JSON.stringify(row));
    }
    await ctx.close();
  }
} finally { await close(); }
