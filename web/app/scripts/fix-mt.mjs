// wasm-bindgen-rayon's worker helper imports its package as a directory
// (`import('../../..')`), which only a bundler can resolve. The threaded engine
// is served unbundled from /pkg-mt/, so point it at the real entry file.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || 'public/pkg-mt';
const entry = 'lintel_wasm.js';
if (!fs.existsSync(path.join(dir, entry))) throw new Error(`no ${entry} in ${dir}`);
let patched = 0;
const walk = (d) => {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f === 'workerHelpers.js') {
      const rel = path.relative(path.dirname(p), path.join(dir, entry)).split(path.sep).join('/');
      const src = fs.readFileSync(p, 'utf8');
      const out = src.replace(/import\((['"])\.\.\/\.\.\/\.\.\1\)/g, `import('${rel}')`);
      if (out !== src) { fs.writeFileSync(p, out); patched++; }
    }
  }
};
walk(dir);
for (const f of ['.gitignore', 'package.json', 'README.md']) fs.rmSync(path.join(dir, f), { force: true });
if (!patched) throw new Error('workerHelpers.js not found or already patched; check wasm-bindgen-rayon output');
console.log(`fix-mt: patched ${patched} worker helper(s) in ${dir}`);
