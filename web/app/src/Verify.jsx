// Public proof check (/verify). Paste a listing ID, a listing link, or an
// offer/listing JSON blob; the browser fetches what it needs from the relay and
// verifies the Halo 2 proofs with the same WASM verifier the marketplace uses
// (crypto('verifyOffer') for single-copy listings and raw offers,
// verifyListing() for multi-copy listings). No wallet, no keys: verifying
// needs only public data. Loaded lazily because it boots the prover.
import { useEffect, useRef, useState } from 'react';
import { crypto, relay, resolveOffer, RELAY } from './api.js';
import { verifyListing } from './presale.js';
import { Link, SiteHeader, SiteFooter, useTitle } from './site.jsx';

const HEX64 = /^[0-9a-f]{64}$/i;
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);
const num = (x) => Number(x).toLocaleString('en-US');

/** What the user pasted: { id } for a listing, or { offer, hash } for a raw offer or listing JSON. */
export function parseInput(raw) {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith('{')) {
    let o;
    try { o = JSON.parse(s); } catch { return { error: 'That looks like JSON but does not parse.' }; }
    const L = o.listing || o; // a relay response or a bare listing
    if (typeof L.offer === 'string' && L.content_hash) return { offer: L.offer, hash: L.content_hash, tPoint: L.t_point, title: L.title };
    if (o.v === 3 || (o.t_point && o.proof && Array.isArray(o.ciphertext))) return { offer: s, hash: o.content_hash };
    if (L.id && L.version === 2) return { id: L.id };
    return { error: 'This JSON is not a Lintel offer or listing.' };
  }
  const m = /listing\/([\w-]+)/.exec(s) || /[?&]id=([\w-]+)/.exec(s);
  if (m) return { id: m[1] };
  if (/^[\w-]{4,64}$/.test(s)) return { id: s };
  return { error: 'Paste a listing ID, a listing link, or an offer JSON.' };
}

const partsOf = (offer) => { try { const o = JSON.parse(offer); return o.v === 3 ? o.parts.length : 1; } catch { return 1; } };

async function check(input) {
  const t0 = performance.now();
  if (input.id) {
    const { listing: L, session } = await relay('GET', `/listings/${encodeURIComponent(input.id)}`);
    if (L.version === 2) {
      const r = await verifyListing(L);
      return { kind: 'multi', L, parts: r.parts, ms: Math.round(performance.now() - t0) };
    }
    const offer = await resolveOffer(L.offer);
    const t = await crypto('verifyOffer', { offer, contentHash: L.content_hash });
    if (t !== L.t_point) throw new Error('the proof is locked to a different key than the listing claims');
    return { kind: 'single', L, session, t, parts: partsOf(L.offer), ms: Math.round(performance.now() - t0) };
  }
  const hash = (input.expected || input.hash || '').trim().toLowerCase();
  if (!HEX64.test(hash)) throw new Error('a 64-character hex content hash is needed to check this offer against');
  const offer = await resolveOffer(input.offer);
  const t = await crypto('verifyOffer', { offer, contentHash: hash });
  if (input.tPoint && t !== input.tPoint) throw new Error('the proof is locked to a different key than the listing claims');
  return { kind: 'offer', hash, t, parts: partsOf(input.offer), title: input.title, ms: Math.round(performance.now() - t0) };
}

function Hex({ v }) {
  return <code className="hexfull" title={v}>{v}</code>;
}

function Txid({ txid }) {
  return <a className="txid" href={`${RELAY}/chain/tx/${txid}`} rel="noreferrer" title="Raw transaction and its block, from the relay's lightwalletd proxy">{txid}</a>;
}

function statusLine(r) {
  const L = r.L;
  if (r.kind === 'multi') return `${num(L.units_open ?? 0)} of ${num(L.units_total ?? L.units?.length ?? 0)} copies open, ${num(L.units_sold ?? 0)} sold. Multi-copy sales settle off-chain and move no coins.`;
  const ch = r.session?.chain || {};
  if (ch.settle_txid) return 'Sold and settled on Zcash testnet. The buyer read the key from the mined settlement.';
  if (ch.funding_txid) return 'A buyer funded the escrow on Zcash testnet. Waiting for the seller to settle, or for the refund lock to pass.';
  if (L.status === 'sold') return 'Sold.';
  if (L.status === 'pending') return 'A buyer has started a purchase.';
  return 'Open: no buyer yet.';
}

function Result({ r }) {
  const L = r.L;
  const ch = r.session?.chain || {};
  const hash = L ? L.content_hash : r.hash;
  const kind = { single: 'Single copy, can settle on Zcash testnet', multi: 'Multi-copy, settles off-chain', offer: 'Offer pasted directly' }[r.kind];
  return (
    <div className="vresult">
      <div className="proof ok" role="status">
        <div>
          <b>Proof verified on this device</b> <span className="muted">({(r.ms / 1000).toFixed(1)} s, including fetching the listing and building the verifying keys)</span>.{' '}
          {r.kind === 'multi'
            ? <>Each copy of this listing decrypts, under its own unlock secret, to content with exactly the hash below. One copy was checked here; a buyer’s app checks the copy it orders again before paying.</>
            : <>The sealed file decrypts, under the secret behind the key <code>T</code> that a payment would be locked to, to content with exactly the hash below. {r.parts > 1 ? `All ${r.parts} parts were checked.` : 'Its single proof was checked.'}</>}
        </div>
      </div>
      <dl className="facts">
        {(L?.title || r.title) && <><dt>Listing</dt><dd>{L ? <a href={`/app#/listing/${L.id}`}>{L.title}</a> : r.title}</dd></>}
        <dt>Kind</dt><dd>{kind}</dd>
        <dt>Proven parts</dt><dd className="mono">{r.parts}{r.kind === 'multi' ? ' (one copy)' : ''}</dd>
        {L && <><dt>Sealed size</dt><dd className="mono">{fmtBytes(L.size)}{L.filename ? ` · ${L.filename}` : ''}</dd></>}
        <dt>Content hash</dt><dd><Hex v={hash} /></dd>
        {r.t && <><dt>Unlock point T</dt><dd><Hex v={r.t} /></dd></>}
        {L && <><dt>Price</dt><dd className="mono">{L.price_zec} {L.version === 2 ? 'ZEC (off-chain, no coins move)' : 'TAZ'}</dd></>}
        {L && <><dt>Status</dt><dd>{statusLine(r)}</dd></>}
        {ch.funding_txid && <><dt>Escrow funded</dt><dd><Txid txid={ch.funding_txid} /></dd></>}
        {ch.settle_txid && <><dt>Settlement</dt><dd><Txid txid={ch.settle_txid} /></dd></>}
      </dl>
      <div className="two vnotes">
        <div className="panel">
          <h3>What this proves</h3>
          <p className="muted">Paying for this listing gets you exactly the content with this hash: the proof ties the ciphertext, the hash and the key the payment unlocks together. A wrong file, a changed byte or a missing part would have failed here.</p>
        </div>
        <div className="panel">
          <h3>What it does not</h3>
          <p className="muted">It does not say the content is worth the price, or that this hash is the one you want. Compare the hash with one the seller published or someone you trust attested.</p>
        </div>
      </div>
    </div>
  );
}

export default function Verify() {
  useTitle('Verify a listing · Lintel');
  const [boot, setBoot] = useState({ state: 'loading' });
  const [text, setText] = useState(() => new URLSearchParams(location.search).get('id') || '');
  const [expected, setExpected] = useState('');
  const [run, setRun] = useState({ state: 'idle' });
  const auto = useRef(!!text);

  useEffect(() => {
    const t0 = performance.now();
    crypto('boot', {}).then(() => setBoot({ state: 'ready', ms: Math.round(performance.now() - t0) })).catch((e) => setBoot({ state: 'error', error: e.message }));
  }, []);

  const go = async (e) => {
    e?.preventDefault();
    const input = parseInput(text);
    if (!input) return;
    if (input.error) { setRun({ state: 'bad', error: input.error }); return; }
    if (input.id) history.replaceState(null, '', `/verify?id=${encodeURIComponent(input.id)}`);
    setRun({ state: 'run', big: input.offer ? partsOf(input.offer) > 1 : null });
    try {
      setRun({ state: 'ok', r: await check({ ...input, expected }) });
    } catch (err) {
      setRun({ state: 'bad', error: err.message });
    }
  };
  useEffect(() => { if (auto.current && boot.state === 'ready') { auto.current = false; go(); } }, [boot.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = parseInput(text);
  const isOffer = parsed && parsed.offer;
  return (
    <div className="site">
      <SiteHeader active="/verify" />
      <main id="content">
        <section className="pagehero">
          <div className="wrap">
            <div className="label">Verify · no wallet needed</div>
            <h1 className="display">Check the proof <em>yourself</em>.</h1>
            <p className="lede">Paste a listing ID or link. Your browser downloads the sealed file’s proofs from the relay and checks every one of them here, with the same verifier a buyer runs before paying. Nothing is sent anywhere.</p>
          </div>
        </section>
        <section className="band verify">
          <div className="wrap">
            <form className="form vform" onSubmit={go}>
              <label>
                <span className="label">Listing ID, listing link, or offer JSON</span>
                <textarea className="mono" rows={isOffer ? 6 : 2} value={text} onChange={(e) => setText(e.target.value)} placeholder="aiypaQiAJTq6   or   https://…/app#/listing/aiypaQiAJTq6" spellCheck={false} />
              </label>
              {isOffer && (
                <label>
                  <span className="label">Content hash you expect (optional)</span>
                  <input className="mono" value={expected} onChange={(e) => setExpected(e.target.value)} placeholder={parsed.hash ? `defaults to the offer’s own hash ${parsed.hash.slice(0, 12)}…` : '64 hex characters'} spellCheck={false} />
                </label>
              )}
              <div className="row start">
                <button className="btn solid" disabled={boot.state !== 'ready' || run.state === 'run' || !text.trim()}>Verify</button>
                <span className={`chip ${boot.state}`} role="status" title={boot.error || ''}>
                  {boot.state === 'loading' && 'Loading the verifier'}
                  {boot.state === 'ready' && <>Verifier ready · <span className="mono">{(boot.ms / 1000).toFixed(1)} s</span></>}
                  {boot.state === 'error' && 'Verifier failed to load'}
                </span>
              </div>
              <p className="muted small">The verifier is the Rust engine compiled to WebAssembly. Big listings fetch a second 2 MB parameter file and take about 1.5 s per proven part in a browser.</p>
            </form>

            {run.state === 'run' && <div className="proof run" role="status"><div>Fetching the listing and verifying its Halo 2 proofs on this device…</div></div>}
            {run.state === 'bad' && <div className="proof bad" role="alert"><div><b>Not verified:</b> {run.error}. {/not found/.test(run.error) ? 'Check the ID; the public relay may also have been reset.' : 'Do not pay for this listing.'}</div></div>}
            {run.state === 'ok' && <Result r={run.r} />}

            <p className="evnote">
              Verifying uses public data only: the listing, its proofs and the pinned parameter files. Reading on-chain status uses the relay at <code>{RELAY}</code>.{' '}
              <Link to="/docs/how-it-works#2-sealed-goods-verifiable-encryption-under-t">What the proof states</Link> · <Link to="/docs/threat-model">Threat model</Link>
            </p>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
