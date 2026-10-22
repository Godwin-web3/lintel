// Copies the brand kit's self-hosted fonts and logo files into public/, so the
// app serves exactly what brand/ ships. Tokens are not copied: main.jsx imports
// brand/tokens.css directly. The social card and app icons come from brand/og.py.
//   node scripts/sync-brand.mjs          copy
//   node scripts/sync-brand.mjs --check  exit 1 if public/ has drifted from brand/
import fs from 'node:fs';

const brand = new URL('../../../brand/', import.meta.url);
const pub = new URL('../public/', import.meta.url);
const files = [
  ...fs.readdirSync(new URL('fonts/', brand)).filter((f) => f.endsWith('.woff2')).map((f) => [`fonts/${f}`, `fonts/${f}`]),
  ...['lockup', 'mark', 'wordmark'].map((k) => [`logo/lintel-${k}-dark.svg`, `brand/lintel-${k}-dark.svg`]),
  ['logo/favicon.svg', 'favicon.svg'],
];
const check = process.argv.includes('--check');
let drift = 0;
for (const [from, to] of files) {
  const src = fs.readFileSync(new URL(from, brand));
  const dst = new URL(to, pub);
  const same = fs.existsSync(dst) && Buffer.compare(src, fs.readFileSync(dst)) === 0;
  if (same) continue;
  drift++;
  if (check) console.error(`out of sync: public/${to} (brand/${from})`);
  else { fs.mkdirSync(new URL('.', dst), { recursive: true }); fs.writeFileSync(dst, src); console.log(`copied brand/${from} -> public/${to}`); }
}
if (check && drift) process.exit(1);
console.log(check ? 'public/ matches brand/' : `synced (${drift} changed)`);
