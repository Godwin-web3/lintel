import fs from 'fs';
import init, * as L from './pkg/lintel_wasm.js';
await init({ module_or_path: fs.readFileSync(new URL('./pkg/lintel_wasm_bg.wasm', import.meta.url)) });
const enc = new TextEncoder();
let t = Date.now(); L.warmUpWithParams(fs.readFileSync(new URL('./params.bin', import.meta.url))); const setup = Date.now() - t;
const payload = enc.encode('Critical: unchecked return in relay lets anyone mint.');
const m = new L.Merchant(), p = new L.Payer();
t = Date.now(); const offer = m.seal(payload); const prove = Date.now() - t;
t = Date.now(); const T = p.verifyOffer(offer, L.contentHash(payload)); const verify = Date.now() - t;
const alpha = '09' + '00'.repeat(31), session = enc.encode('s1'), sh = enc.encode('sighash');
const ra = p.nonce();
const partial = m.partial(ra, p.verificationKey(), alpha, sh);
const pok = m.proveKnowledge(p.verificationKey(), session);
const pre = p.preSign(m.verificationKey(), partial, sh, session, pok, alpha, T);
const ok = m.verifyPresig(pre, ra, partial, p.verificationKey(), alpha);
const sig = m.complete(pre, partial);
const out = new TextDecoder().decode(p.unlock(sig, pre, partial, offer));
let bad; try { p.verifyOffer(offer, L.contentHash(enc.encode('junk'))); bad = 'accepted!'; } catch (e) { bad = 'rejected: ' + e.message; }
console.log(JSON.stringify({ setup_ms: setup, prove_ms: prove, verify_ms: verify, presig_ok: ok, decrypted_ok: out === new TextDecoder().decode(payload), wrong_hash: bad, offer_kb: Math.round(offer.length/1024) }));
