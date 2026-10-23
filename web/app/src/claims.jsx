// Proven claims (predicates): public statements about the sealed content that
// are proven inside the same Halo 2 proof as the decryption, over the same
// plaintext (engine/src/predicate.rs). Sellers add them when listing; buyers
// see them in plain English next to the verified proof.
import { useEffect, useState } from 'react';
import { crypto } from './api.js';

export const EMPTY_CLAIMS = { prefix: '', min: '', max: '', at: '', atValue: '' };

const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
/** "0x25504446" is hex; anything else is UTF-8 text. */
export function bytesHex(s) {
  const t = s.trim();
  if (/^0x[0-9a-fA-F]*$/.test(t)) {
    if (t.length % 2) throw new Error(`${t} has an odd number of hex digits`);
    return t.slice(2).toLowerCase();
  }
  return toHex(new TextEncoder().encode(s));
}

// Payload bytes an offer v3 of `size` bytes can hold (768 elements of 31 bytes per part, element 0 = length).
const capacity = (size) => { const parts = Math.max(1, Math.ceil((1 + Math.ceil(size / 31)) / 768)); return (768 * parts - 1) * 31; };

/** Form state -> claims JSON (string), or '' when no claim is filled in. `size`: payload bytes. */
export function claimsJson(c, size = 0) {
  const out = [];
  if (c.prefix.trim()) out.push({ id: 'prefix', hex: bytesHex(c.prefix) });
  if (c.min.trim() || c.max.trim()) {
    const min = Number(c.min || 0), max = c.max.trim() ? Number(c.max) : capacity(size);
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) throw new Error('length bounds must be whole numbers of bytes');
    out.push({ id: 'length', min, max });
  }
  if (c.atValue.trim()) {
    const offset = Number(c.at || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a whole number of bytes');
    out.push({ id: 'bytes_at', offset, hex: bytesHex(c.atValue) });
  }
  return out.length ? JSON.stringify(out) : '';
}

/**
 * Seller form section. Checks the claims against the content in the prover
 * (same rules as the circuit) and previews what buyers will read.
 */
export function ClaimsEditor({ value, onChange, payload, contentKey, size, ready, onStatus }) {
  const [status, setStatus] = useState({ state: 'none' });
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });

  useEffect(() => {
    let json;
    try { json = claimsJson(value, size); } catch (e) { const s = { state: 'bad', error: e.message }; setStatus(s); onStatus?.(s); return; }
    if (!json) { const s = { state: 'none' }; setStatus(s); onStatus?.(s); return; }
    if (!ready) return;
    let stop = false;
    const id = setTimeout(async () => {
      try {
        const bytes = await payload();
        const list = await crypto('checkClaims', { claims: json, payload: bytes });
        if (!stop) { const s = { state: 'ok', json, list }; setStatus(s); onStatus?.(s); }
      } catch (e) {
        if (!stop) { const s = { state: 'bad', error: e.message }; setStatus(s); onStatus?.(s); }
      }
    }, 300);
    return () => { stop = true; clearTimeout(id); };
  }, [value, contentKey, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <fieldset className="claims-edit">
      <legend className="label">Proven claims (optional)</legend>
      <p className="muted small">
        Public facts about the content, proven inside the same proof as the decryption, so buyers see them
        verified before they pay. They must hold for your file, and they are public. Byte claims cover the first
        23,777 bytes, up to 32 bytes each.
      </p>
      <label><span className="label">Starts with</span>
        <input className="mono" value={value.prefix} onChange={set('prefix')} placeholder="%PDF  or  0x25504446" maxLength={66} />
      </label>
      <div className="row2">
        <label><span className="label">Length at least (bytes)</span><input className="mono" inputMode="numeric" value={value.min} onChange={set('min')} placeholder="1000" /></label>
        <label><span className="label">Length at most (bytes)</span><input className="mono" inputMode="numeric" value={value.max} onChange={set('max')} placeholder="25000" /></label>
      </div>
      <div className="row2">
        <label><span className="label">Bytes at offset</span><input className="mono" inputMode="numeric" value={value.at} onChange={set('at')} placeholder="64" /></label>
        <label><span className="label">Equal</span><input className="mono" value={value.atValue} onChange={set('atValue')} placeholder="0x5aa5…  or  text" maxLength={66} /></label>
      </div>
      {status.state === 'ok' && (
        <div className="small">
          <span className="muted">Buyers will see:</span>
          <ClaimList claims={status.list} pending />
        </div>
      )}
      {status.state === 'bad' && <p className="error small" role="alert">{status.error}</p>}
    </fieldset>
  );
}

/** Plain-English claims. `pending`: not yet proven (seller preview). */
export function ClaimList({ claims, pending = false }) {
  if (!claims?.length) return null;
  return (
    <ul className={`claims${pending ? ' pending' : ''}`}>
      {claims.map((c, i) => <li key={i}><span className="mono">{c.text}</span></li>)}
    </ul>
  );
}
