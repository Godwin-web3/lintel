// Refuses to publish without the WASM engines and proving parameters (built
// by `npm run build:wasm`), since the package is useless without them.
import { existsSync, statSync } from 'node:fs';
const need = ['wasm/core/lintel_wasm.js', 'wasm/core/lintel_wasm_bg.wasm', 'wasm/chain/lintel_chain.js', 'wasm/chain/lintel_chain_bg.wasm', 'params/params.bin', 'params/params-big.bin'];
const missing = need.filter((f) => !existsSync(new URL(`../${f}`, import.meta.url)) || statSync(new URL(`../${f}`, import.meta.url)).size === 0);
if (missing.length) { console.error(`missing build artifacts (run npm run build:wasm): ${missing.join(', ')}`); process.exit(1); }
console.log('wasm + params present');
