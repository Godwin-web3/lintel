import { useEffect, useRef, useState } from 'react';
import { crypto, relay, store, randomHex, randomAlpha, sleep, RELAY } from './api.js';

// ---------- tiny hash router ----------
function useRoute() {
  const [hash, setHash] = useState(location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1) || '/');
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash.split('/').filter(Boolean);
}
const go = (p) => (location.hash = p);

// ---------- shared bits ----------
const short = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '');
const fmtBytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

function Steps({ steps }) {
  return (
    <ol className="steps">
      {steps.map(([label, state, note], i) => (
        <li key={i} className={state}>
          <span className="dot">{state === 'done' ? '✓' : state === 'fail' ? '!' : i + 1}</span>
          <div>
            <b>{label}</b>
            {note && <small>{note}</small>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Notice() {
  return (
    <div className="notice">
      <b>Experimental.</b> Proofs, adaptor signatures and decryption are real and run on your device.
      Settlement is not on-chain yet: the completed signature is exchanged through the relay instead of
      inside a broadcast Zcash transaction, and no ZEC moves.
    </div>
  );
}

// ---------- app ----------
export default function App() {
  const route = useRoute();
  const [boot, setBoot] = useState({ state: 'loading' });

  useEffect(() => {
    const t0 = performance.now();
    crypto('boot')
      .then((r) => setBoot({ state: 'ready', ...r, ms: Math.round(performance.now() - t0) }))
      .catch((e) => setBoot({ state: 'error', error: e.message }));
  }, []);

  let page;
  if (route[0] === 'sell') page = <Sell boot={boot} />;
  else if (route[0] === 'listing' && route[1]) page = <Listing id={route[1]} boot={boot} />;
  else if (route[0] === 'mine') page = <Mine boot={boot} />;
  else page = <Market />;

  return (
    <div className="shell">
      <header>
        <a className="brand" href="#/">
          <span className="logo">◆</span> Lintel
        </a>
        <nav>
          <a href="#/" className={!route[0] ? 'on' : ''}>Market</a>
          <a href="#/sell" className={route[0] === 'sell' ? 'on' : ''}>Sell</a>
          <a href="#/mine" className={route[0] === 'mine' ? 'on' : ''}>My sales</a>
        </nav>
        <span className={`engine ${boot.state}`} title={boot.error || ''}>
          {boot.state === 'loading' && 'Loading prover…'}
          {boot.state === 'ready' && `Prover ready · ${(boot.ms / 1000).toFixed(1)}s`}
          {boot.state === 'error' && 'Prover failed to load'}
        </span>
      </header>
      <main>{page}</main>
      <footer>
        Keys, the unlock secret and plaintext never leave this browser. The relay at <code>{RELAY}</code> only
        sees public data.
      </footer>
    </div>
  );
}

// ---------- market ----------
function Market() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    relay('GET', '/listings').then((r) => setRows(r.listings)).catch((e) => setErr(e.message));
  }, []);
  return (
    <section>
      <div className="hero">
        <h1>Pay to decrypt, privately.</h1>
        <p>
          Sell a secret, a report or a file. Buyers verify a zero-knowledge proof that the sealed content is
          exactly what you committed to, and the payment signature itself hands them the key. No escrow, no
          trusted middleman.
        </p>
        <a className="btn" href="#/sell">Sell something</a>
      </div>
      <Notice />
      <h2>Open listings</h2>
      {err && <p className="error">{err}</p>}
      {!rows && !err && <p className="muted">Loading…</p>}
      {rows && rows.length === 0 && <p className="muted">Nothing listed yet.</p>}
      <div className="grid">
        {rows?.map((l) => (
          <a key={l.id} className={`card ${l.status}`} href={`#/listing/${l.id}`}>
            <div className="row">
              <b>{l.title}</b>
              <span className="price">{l.price_zec} ZEC</span>
            </div>
            <p>{l.description || <i className="muted">No description</i>}</p>
            <div className="row muted small">
              <span>{fmtBytes(l.size)} sealed</span>
              <span className={`tag ${l.status}`}>{l.status}</span>
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}

// ---------- sell ----------
function Sell({ boot }) {
  const [form, setForm] = useState({ title: '', description: '', price: '', text: '' });
  const [file, setFile] = useState(null);
  const [steps, setSteps] = useState(null);
  const [err, setErr] = useState('');
  const max = boot.maxPayload || 1953;

  const payloadBytes = async () => (file ? new Uint8Array(await file.arrayBuffer()) : new TextEncoder().encode(form.text));
  const size = file ? file.size : new TextEncoder().encode(form.text).length;

  async function submit(e) {
    e.preventDefault();
    setErr('');
    const s = [['Seal content and build Halo 2 proof', 'run'], ['Publish public listing to relay', 'wait'], ['Save seller keys on this device', 'wait']];
    setSteps([...s]);
    try {
      const payload = await payloadBytes();
      const t0 = performance.now();
      const sealed = await crypto('seal', { payload });
      s[0] = ['Seal content and build Halo 2 proof', 'done', `${((performance.now() - t0) / 1000).toFixed(1)}s on this device`];
      s[1][1] = 'run'; setSteps([...s]);
      const { listing, seller_token } = await relay('POST', '/listings', {
        title: form.title.trim(), description: form.description.trim(), price_zec: form.price.trim(),
        content_hash: sealed.contentHash, merchant_vk: sealed.merchantVk, t_point: sealed.tPoint,
        offer: sealed.offer, filename: file?.name, size: payload.length,
      });
      s[1] = ['Publish public listing to relay', 'done', `content hash ${short(sealed.contentHash)}`];
      s[2][1] = 'run'; setSteps([...s]);
      store.put((st) => { st.selling[listing.id] = { state: sealed.state, token: seller_token, title: listing.title }; });
      s[2][1] = 'done'; setSteps([...s]);
      setTimeout(() => go(`/mine`), 600);
    } catch (e2) {
      const i = s.findIndex((x) => x[1] === 'run');
      if (i >= 0) s[i][1] = 'fail';
      setSteps([...s]); setErr(e2.message);
    }
  }

  const busy = steps && steps.some((x) => x[1] === 'run');
  return (
    <section className="narrow">
      <h1>Sell sealed content</h1>
      <p className="muted">
        Your content is encrypted in this browser under a fresh secret. Only the matching payment signature
        reveals that secret to the buyer. Each listing sells once.
      </p>
      <form onSubmit={submit} className="form">
        <label>Title<input required maxLength={120} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Critical bug report: Acme vault" /></label>
        <label>Public description<textarea maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What the buyer gets, without giving it away" /></label>
        <label>Price (ZEC)<input required inputMode="decimal" pattern="\d{1,8}(\.\d{1,8})?" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="0.5" /></label>
        <label>Secret content
          <textarea className="mono" rows={6} disabled={!!file} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} placeholder="Paste the secret text here, or attach a small file below" />
        </label>
        <label className="file">Or attach a file<input type="file" onChange={(e) => setFile(e.target.files[0] || null)} /></label>
        <div className={`row small ${size > max ? 'error' : 'muted'}`}>
          <span>{fmtBytes(size)} of {fmtBytes(max)} per listing</span>
          <span>Filename is public if you attach one</span>
        </div>
        <button className="btn" disabled={busy || boot.state !== 'ready' || size === 0 || size > max}>
          {boot.state !== 'ready' ? 'Waiting for prover…' : busy ? 'Working…' : 'Seal and list'}
        </button>
      </form>
      {steps && <Steps steps={steps} />}
      {busy && steps[0][1] === 'run' && <p className="muted small">Proving takes up to a minute on phones. Keep this tab open.</p>}
      {err && <p className="error">{err}</p>}
    </section>
  );
}

// ---------- my sales (seller side of the protocol) ----------
function Mine({ boot }) {
  const [mine, setMine] = useState(() => store.get().selling);
  const [live, setLive] = useState({});
  const busy = useRef(new Set());

  useEffect(() => {
    if (boot.state !== 'ready') return;
    let stop = false;
    (async () => {
      for (const [id, s] of Object.entries(mine)) await crypto('loadMerchant', { key: id, state: s.state }).catch(() => {});
      while (!stop) {
        const next = {};
        for (const [id, s] of Object.entries(mine)) {
          try {
            const { listing, session } = await relay('GET', `/listings/${id}`);
            next[id] = { listing, session, note: '' };
            if (session && !busy.current.has(id)) {
              busy.current.add(id);
              try {
                if (!session.partial) {
                  const r = await crypto('respond', { key: id, payerVk: session.payer_vk, rA: session.r_a, alpha: session.alpha, sighash: session.sighash, sessionId: session.id });
                  await relay('POST', `/sessions/${session.id}/partial`, { partial: r.partial, merchant_pok: r.pok }, s.token);
                  next[id].note = 'Sent partial signature to buyer';
                } else if (session.presig && !session.signature) {
                  const sig = await crypto('complete', { key: id, presig: session.presig, rA: session.r_a, partial: session.partial, payerVk: session.payer_vk, alpha: session.alpha });
                  await relay('POST', `/sessions/${session.id}/signature`, { signature: sig }, s.token);
                  next[id].note = 'Completed signature and released it';
                }
              } catch (e) { next[id].note = e.message; }
              busy.current.delete(id);
            }
          } catch (e) { next[id] = { error: e.message }; }
        }
        if (!stop) setLive(next);
        await sleep(2500);
      }
    })();
    return () => { stop = true; };
  }, [boot.state, mine]);

  const forget = (id) => {
    if (!confirm('Delete the seller keys for this listing from this device? You will not be able to complete its sale.')) return;
    setMine(store.put((st) => delete st.selling[id]).selling);
  };

  const ids = Object.keys(mine);
  return (
    <section>
      <h1>My sales</h1>
      <p className="muted">Keep this page open while a buyer is purchasing: your browser answers each protocol step automatically.</p>
      <Notice />
      {ids.length === 0 && <p className="muted">No listings on this device. <a href="#/sell">Sell something</a>.</p>}
      <div className="grid">
        {ids.map((id) => {
          const l = live[id];
          const sess = l?.session;
          const stage = !sess ? 'Waiting for a buyer' : !sess.partial ? 'Buyer joined' : !sess.presig ? 'Waiting for buyer pre-signature' : !sess.signature ? 'Completing' : 'Sold';
          return (
            <div key={id} className="card">
              <div className="row"><b>{mine[id].title}</b>{l?.listing && <span className="price">{l.listing.price_zec} ZEC</span>}</div>
              {l?.error ? <p className="error">{l.error}</p> : <p>{l ? stage : 'Checking…'}</p>}
              {l?.note && <p className="small muted">{l.note}</p>}
              <div className="row small">
                <a href={`#/listing/${id}`}>View listing</a>
                <button className="link danger" onClick={() => forget(id)}>Forget keys</button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------- listing (buyer side) ----------
function Listing({ id, boot }) {
  const [data, setData] = useState(null);
  const [verify, setVerify] = useState({ state: 'idle' });
  const [steps, setSteps] = useState(null);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);
  const isMine = !!store.get().selling[id];

  useEffect(() => { relay('GET', `/listings/${id}`).then(setData).catch((e) => setErr(e.message)); }, [id]);

  useEffect(() => {
    if (!data || boot.state !== 'ready' || verify.state !== 'idle') return;
    setVerify({ state: 'run' });
    const t0 = performance.now();
    crypto('verifyOffer', { offer: data.listing.offer, contentHash: data.listing.content_hash })
      .then((t) => {
        if (t !== data.listing.t_point) throw new Error('offer is locked to a different key than the listing claims');
        setVerify({ state: 'ok', t, ms: Math.round(performance.now() - t0) });
      })
      .catch((e) => setVerify({ state: 'bad', error: e.message }));
  }, [data, boot.state, verify.state]);

  async function buy() {
    setErr('');
    const L = data.listing;
    const s = [
      ['Join sale and send nonce', 'run'],
      ['Receive seller partial signature', 'wait'],
      ['Pre-sign, locked to the unlock point', 'wait'],
      ['Seller completes the signature', 'wait', 'On-chain, this is the broadcast payment'],
      ['Extract secret and decrypt', 'wait'],
    ];
    const upd = () => setSteps(s.map((x) => [...x]));
    upd();
    try {
      const tmp = 'p-' + randomHex(8);
      const { payerVk, rA } = await crypto('startPurchase', { key: tmp });
      const sighash = randomHex(32), alpha = randomAlpha(); // placeholders until PCZT supplies them
      const { session, buyer_token } = await relay('POST', `/listings/${id}/sessions`, { payer_vk: payerVk, r_a: rA, alpha, sighash });
      await crypto('rebindPayer', { from: tmp, to: session.id });
      store.put((st) => { st.buying[id] = { session: session.id, token: buyer_token }; });
      s[0][1] = 'done'; s[1][1] = 'run'; upd();

      let sess = session;
      while (!sess.partial) { await sleep(2000); sess = (await relay('GET', `/sessions/${session.id}`)).session; }
      s[1][1] = 'done'; s[2][1] = 'run'; upd();

      const presig = await crypto('preSign', { key: session.id, merchantVk: L.merchant_vk, partial: sess.partial, sighash, sessionId: session.id, pok: sess.merchant_pok, alpha, verifiedT: verify.t });
      await relay('POST', `/sessions/${session.id}/presig`, { presig }, buyer_token);
      s[2][1] = 'done'; s[3][1] = 'run'; upd();

      while (!sess.signature) { await sleep(2000); sess = (await relay('GET', `/sessions/${session.id}`)).session; }
      s[3][1] = 'done'; s[4][1] = 'run'; upd();

      const bytes = await crypto('unlock', { key: session.id, signature: sess.signature, presig, partial: sess.partial, offer: L.offer });
      s[4][1] = 'done'; upd();
      relay('GET', `/listings/${id}`).then(setData).catch(() => {});
      const text = (() => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; } })();
      setResult({ bytes, text, name: L.filename || `${L.title.replace(/[^\w-]+/g, '_')}.txt` });
    } catch (e) {
      const i = s.findIndex((x) => x[1] === 'run');
      if (i >= 0) s[i][1] = 'fail';
      upd(); setErr(e.message);
    }
  }

  const download = () => {
    const url = URL.createObjectURL(new Blob([result.bytes]));
    const a = Object.assign(document.createElement('a'), { href: url, download: result.name });
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (err && !data) return <section className="narrow"><p className="error">{err}</p></section>;
  if (!data) return <section className="narrow"><p className="muted">Loading…</p></section>;
  const L = data.listing;
  const canBuy = verify.state === 'ok' && L.status === 'open' && !isMine && !steps;

  return (
    <section className="narrow">
      <a href="#/" className="small">← Market</a>
      <div className="row"><h1>{L.title}</h1><span className="price big">{L.price_zec} ZEC</span></div>
      {L.description && <p>{L.description}</p>}
      <dl className="facts">
        <dt>Sealed size</dt><dd>{fmtBytes(L.size)}{L.filename ? ` · ${L.filename}` : ''}</dd>
        <dt>Content hash</dt><dd className="mono">{short(L.content_hash)}</dd>
        <dt>Unlock point T</dt><dd className="mono">{short(L.t_point)}</dd>
        <dt>Status</dt><dd><span className={`tag ${L.status}`}>{L.status}</span></dd>
      </dl>

      <div className={`proof ${verify.state}`}>
        {verify.state === 'idle' && 'Waiting for prover…'}
        {verify.state === 'run' && 'Verifying Halo 2 proof on this device…'}
        {verify.state === 'ok' && <>✓ Proof verified in {verify.ms} ms: the ciphertext decrypts, under the secret behind T, to content with this exact hash.</>}
        {verify.state === 'bad' && <>✗ Proof rejected: {verify.error}. Do not buy.</>}
      </div>

      <Notice />
      {isMine && <p className="muted">This is your listing. Keep <a href="#/mine">My sales</a> open to serve buyers.</p>}
      {canBuy && <button className="btn" onClick={buy}>Buy for {L.price_zec} ZEC</button>}
      {L.status !== 'open' && !steps && !isMine && <p className="muted">This listing already has a buyer.</p>}
      {steps && <Steps steps={steps} />}
      {steps && !result && !err && <p className="muted small">Keep this tab open until the content unlocks.</p>}
      {err && <p className="error">{err}</p>}

      {result && (
        <div className="unlocked">
          <h2>Unlocked</h2>
          {result.text !== null ? <pre>{result.text}</pre> : <p className="muted">Binary file, {fmtBytes(result.bytes.length)}.</p>}
          <button className="btn" onClick={download}>Download</button>
        </div>
      )}
    </section>
  );
}
