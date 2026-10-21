import { useEffect, useRef, useState } from 'react';
import { crypto, relay, store, randomHex, randomAlpha, sleep, RELAY } from './api.js';
import { sellV2, startSellerAgent, MAX_COPIES } from './presale.js';
import { ListingV2, SellerCardV2, Purchases, copiesLabel } from './Presale.jsx';
import { WalletPanel, OnchainBuy } from './Onchain.jsx';
import { advanceSeller } from './onchain.js';
import { Link, Lockup, NotFound, useTitle } from './site.jsx';

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
export const Amt = ({ v, unit = 'ZEC', big }) => <span className={`amt${big ? ' big' : ''}`}>{v}<span className="unit">{unit}</span></span>;

function Steps({ steps }) {
  return (
    <ol className="steps">
      {steps.map(([label, state, note], i) => (
        <li key={i} className={state} aria-current={state === 'run' ? 'step' : undefined}>
          <span className="dot" aria-hidden="true">{state === 'done' ? '✓' : state === 'fail' ? '!' : i + 1}</span>
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
    <div className="notice" role="note">
      <span className="label">Testnet</span>
      <div>
        Proofs, adaptor signatures and decryption are real and run on this device. <b>Single-copy listings</b> can
        settle on Zcash testnet: escrow, time-locked refund and settlement are built, proven and checked in your
        browser, and the key is read from the mined transaction. <b>Multi-copy listings</b> still settle
        off-chain: the completed signature goes through the relay and no ZEC moves.
      </div>
    </div>
  );
}

// ---------- app ----------
export default function App() {
  const route = useRoute();
  const [boot, setBoot] = useState({ state: 'loading' });
  const [agent, setAgent] = useState({});

  useEffect(() => {
    const t0 = performance.now();
    // ?threads=0 forces the single-threaded engine (for comparison).
    crypto('boot', { threads: new URLSearchParams(location.search).get('threads') })
      .then((r) => setBoot({ state: 'ready', ...r, ms: Math.round(performance.now() - t0) }))
      .catch((e) => setBoot({ state: 'error', error: e.message }));
  }, []);

  // Presale listings complete in the background on any page, not only "My sales".
  useEffect(() => (boot.state === 'ready' ? startSellerAgent(setAgent) : undefined), [boot.state]);

  let page;
  if (route[0] === 'sell') page = <Sell boot={boot} />;
  else if (route[0] === 'listing' && route[1]) page = <Listing id={route[1]} boot={boot} />;
  else if (route[0] === 'mine') page = <Mine boot={boot} agent={agent} />;
  else if (route[0] === 'wallet') page = <WalletPanel boot={boot} />;
  else if (!route[0]) page = <Market />;
  else page = <NotFound inApp />;

  const tab = route[0] || '';
  const navItem = (href, key, label) => (
    <a href={href} className={tab === key ? 'on' : ''} aria-current={tab === key ? 'page' : undefined}>{label}</a>
  );
  return (
    <div className="shell">
      <a className="skip" href="#content">Skip to content</a>
      <header className="appbar">
        <Link to="/" className="brandlink" aria-label="Lintel home"><Lockup /></Link>
        <nav className="appnav" aria-label="Marketplace">
          {navItem('#/', '', 'Market')}
          {navItem('#/sell', 'sell', 'Sell')}
          {navItem('#/mine', 'mine', 'My sales')}
          {navItem('#/wallet', 'wallet', 'Wallet')}
          <Link to="/docs">Docs</Link>
        </nav>
        <span className={`engine chip ${boot.state}`} title={boot.error || ''} role="status">
          {boot.state === 'loading' && 'Loading prover'}
          {boot.state === 'ready' && <>Prover ready · <span className="mono">{(boot.ms / 1000).toFixed(1)}s</span> · {boot.threads > 1 ? `${boot.threads} threads` : '1 thread'}</>}
          {boot.state === 'error' && 'Prover failed to load'}
        </span>
      </header>
      <main id="content">{page}</main>
      <footer className="appfoot">
        <span>Key shares, the unlock secret and plaintext never leave this browser. The relay at <code>{RELAY}</code> sees public data only.</span>
        <nav aria-label="Footer"><Link to="/">About</Link><Link to="/docs/security-model">Security model</Link><a href="https://github.com/Godwin-web3/lintel" rel="noreferrer">GitHub</a></nav>
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
  useTitle('Marketplace · Lintel');
  return (
    <section>
      <div className="pagehead">
        <div>
          <div className="label">Marketplace · Zcash testnet</div>
          <h1>Sealed goods, <em className="key">proven</em> before you pay.</h1>
          <p>
            Each listing carries a zero-knowledge proof that its ciphertext opens to content with the stated hash.
            Your browser checks it before you buy, and the payment signature hands you the key.
          </p>
        </div>
        <a className="btn ghost" href="#/sell">Sell something</a>
      </div>
      <Notice />
      <h2>Open listings</h2>
      {err && <p className="error" role="alert">Could not reach the relay: {err}</p>}
      {!rows && !err && <p className="muted">Loading listings…</p>}
      {rows && rows.length === 0 && <div className="empty">Nothing listed yet. <a href="#/sell">List the first one</a>.</div>}
      <div className="grid">
        {rows?.map((l) => (
          <a key={l.id} className={`card ${l.status}`} href={`#/listing/${l.id}`}>
            <div className="row title-row">
              <b>{l.title}</b>
              <Amt v={l.price_zec} />
            </div>
            <p>{l.description || <span className="muted">No description</span>}</p>
            <div className="meta">
              <span className="mono">{fmtBytes(l.size)} sealed{copiesLabel(l) ? ` · ${copiesLabel(l)}` : ''}</span>
              <span className={`tag ${l.status}`}>{l.status}</span>
            </div>
          </a>
        ))}
      </div>
      <Purchases />
    </section>
  );
}

// ---------- sell ----------
function Sell({ boot }) {
  const [form, setForm] = useState({ title: '', description: '', price: '', text: '', copies: '1', onchain: false });
  const [file, setFile] = useState(null);
  const [steps, setSteps] = useState(null);
  const [err, setErr] = useState('');
  const max = boot.maxPayloadV2 || 7905;

  const payloadBytes = async () => (file ? new Uint8Array(await file.arrayBuffer()) : new TextEncoder().encode(form.text));
  const size = file ? file.size : new TextEncoder().encode(form.text).length;

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (form.onchain) return submitOnchain();
    const copies = Math.max(1, Math.min(MAX_COPIES, Number(form.copies) || 1));
    const s = [[`Seal ${copies} cop${copies > 1 ? 'ies' : 'y'}, each under its own secret, with Halo 2 proofs`, 'run'], ['Publish to relay and keep seller keys on this device', 'wait']];
    setSteps([...s]);
    try {
      const payload = await payloadBytes();
      const t0 = performance.now();
      // Presale (v2): every copy is pre-sealed now, so buyers never wait for this device.
      await sellV2({
        payload, copies,
        meta: { title: form.title.trim(), description: form.description.trim(), price_zec: form.price.trim(), filename: file?.name },
        onStep: (i, n, ms) => {
          s[0][2] = `copy ${i}/${n} sealed in ${(ms / 1000).toFixed(1)}s`;
          s[1][1] = 'run'; setSteps(s.map((x) => [...x]));
        },
      });
      s[0] = [s[0][0], 'done', `${((performance.now() - t0) / 1000).toFixed(1)}s total on this device`];
      s[1][1] = 'done'; setSteps(s.map((x) => [...x]));
      setTimeout(() => go(`/mine`), 600);
    } catch (e2) {
      const i = s.findIndex((x) => x[1] === 'run');
      if (i >= 0) s[i][1] = 'fail';
      setSteps([...s]); setErr(e2.message);
    }
  }

  // Single copy, settled on Zcash testnet (v1 listing; the buyer funds an escrow).
  async function submitOnchain() {
    const s = [['Seal with a Halo 2 proof (single copy)', 'run'], ['Publish to relay and keep seller keys on this device', 'wait']];
    setSteps([...s]);
    try {
      const payload = await payloadBytes();
      if (payload.length > (boot.maxPayload || 1953)) throw new Error(`on-chain listings hold up to ${boot.maxPayload || 1953} bytes`);
      const t0 = performance.now();
      const r = await crypto('seal', { payload });
      s[0] = [s[0][0], 'done', `${((performance.now() - t0) / 1000).toFixed(1)}s on this device`]; s[1][1] = 'run'; setSteps(s.map((x) => [...x]));
      const { listing, seller_token } = await relay('POST', '/listings', {
        title: form.title.trim(), description: form.description.trim(), price_zec: form.price.trim(), filename: file?.name,
        content_hash: r.contentHash, merchant_vk: r.merchantVk, t_point: r.tPoint, offer: r.offer, size: payload.length,
      });
      store.put((st) => { st.selling[listing.id] = { title: listing.title, state: r.state, token: seller_token, onchain: true }; });
      s[1][1] = 'done'; setSteps(s.map((x) => [...x]));
      setTimeout(() => go(`/mine`), 600);
    } catch (e2) {
      const i = s.findIndex((x) => x[1] === 'run');
      if (i >= 0) s[i][1] = 'fail';
      setSteps([...s]); setErr(e2.message);
    }
  }

  const busy = steps && steps.some((x) => x[1] === 'run');
  useTitle('Sell · Lintel');
  return (
    <section className="narrow">
      <div className="label">Sell</div>
      <h1>Seal something to sell.</h1>
      <p className="lede">
        The content is encrypted in this browser and never leaves it in the clear. Each copy gets its own secret,
        so one sale never unlocks another. Buyers can order while you are offline; their sales complete the next
        time this app is open on this device.
      </p>
      <form onSubmit={submit} className="form">
        <label><span className="label">Title</span><input required maxLength={120} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Critical bug report: Acme vault" /></label>
        <label><span className="label">Public description</span><textarea maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What the buyer gets, without giving it away" /></label>
        <label><span className="label">Price ({form.onchain ? 'TAZ' : 'ZEC'})</span><input className="mono" required inputMode="decimal" pattern="\d{1,8}(\.\d{1,8})?" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="0.5" /></label>
        <label className="check"><input type="checkbox" checked={form.onchain} onChange={(e) => setForm({ ...form, onchain: e.target.checked })} /> <span><b>Settle on Zcash testnet.</b> One copy, priced in TAZ, up to {fmtBytes(boot.maxPayload || 1953)}. Keep My sales open while a buyer pays: your app co-signs their refund and broadcasts the settlement.</span></label>
        {!form.onchain && <label><span className="label">Copies for sale</span><input className="mono" type="number" min={1} max={MAX_COPIES} value={form.copies} onChange={(e) => setForm({ ...form, copies: e.target.value })} /></label>}
        <label><span className="label">Secret content</span>
          <textarea className="mono" rows={6} disabled={!!file} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} placeholder="Paste the secret text here, or attach a small file below" />
        </label>
        <label className="file"><span className="label">Or attach a file</span><input type="file" onChange={(e) => setFile(e.target.files[0] || null)} /></label>
        <div className={`meter ${size > max ? 'error' : 'muted'}`}>
          <span className="mono">{fmtBytes(size)} / {fmtBytes(max)}</span>
          <span>The filename is public if you attach a file.</span>
        </div>
        <button className="btn" disabled={busy || boot.state !== 'ready' || size === 0 || size > max}>
          {boot.state !== 'ready' ? 'Waiting for the prover…' : busy ? 'Sealing…' : 'Seal and list'}
        </button>
      </form>
      {steps && <Steps steps={steps} />}
      {busy && steps[0][1] === 'run' && <p className="muted small">Each copy needs its own proof, and files over 1.9 KB need more than one. Keep this tab open until listing finishes.</p>}
      {err && <p className="error" role="alert">{err}</p>}
    </section>
  );
}

// ---------- my sales (seller side of the protocol) ----------
function Mine({ boot, agent = {} }) {
  const [mine, setMine] = useState(() => store.get().selling);
  const [live, setLive] = useState({});
  const busy = useRef(new Set());

  useEffect(() => {
    if (boot.state !== 'ready') return;
    let stop = false;
    (async () => {
      const v1 = Object.entries(mine).filter(([, s]) => s.v !== 2); // presale listings run in the background agent
      for (const [id, s] of v1) await crypto('loadMerchant', { key: id, state: s.state }).catch(() => {});
      while (!stop) {
        const next = {};
        for (const [id, s] of v1) {
          try {
            const { listing, session } = await relay('GET', `/listings/${id}`);
            next[id] = { listing, session, note: '' };
            if (session && session.mode === 'chain' && !busy.current.has(id)) {
              busy.current.add(id);
              try { next[id].note = await advanceSeller(id, store.get().selling[id], listing, session); } catch (e) { next[id].note = e.message; }
              busy.current.delete(id);
            } else if (session && !busy.current.has(id)) {
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
  useTitle('My sales · Lintel');
  return (
    <section>
      <div className="pagehead">
        <div>
          <div className="label">Seller</div>
          <h1>My sales</h1>
          <p>
            Multi-copy listings complete on their own whenever this app is open on this device, on any app page.
            Buyers pre-sign right away; your next visit releases their keys. Single-copy and on-chain listings need
            this page open while a buyer is paying.
          </p>
        </div>
      </div>
      <Notice />
      {ids.length === 0 && <div className="empty">No listings on this device. <a href="#/sell">Seal something to sell</a>.</div>}
      <div className="grid">
        {ids.map((id) => {
          if (mine[id].v === 2) return <SellerCardV2 key={id} id={id} entry={mine[id]} agent={agent[id]} onForget={forget} boot={boot} />;
          const l = live[id];
          const sess = l?.session;
          const stage = sess?.mode === 'chain' ? (sess.chain?.settle_txid ? 'Settled on chain' : 'On-chain sale in progress') : !sess ? 'Waiting for a buyer' : !sess.partial ? 'Buyer joined' : !sess.presig ? 'Waiting for the buyer’s pre-signature' : !sess.signature ? 'Completing' : 'Sold';
          const tone = !l ? '' : l.error ? 'error' : stage === 'Sold' || stage === 'Settled on chain' ? 'ok' : sess ? 'pending' : '';
          return (
            <div key={id} className="card">
              <div className="row title-row"><b>{mine[id].title}</b>{l?.listing && <Amt v={l.listing.price_zec} unit={mine[id].onchain ? 'TAZ' : 'ZEC'} />}</div>
              {l?.error ? <p className="error">{l.error}</p> : <p><span className={`chip ${tone}`}>{l ? stage : 'Checking'}</span></p>}
              {l?.note && <p className="small muted">{l.note}</p>}
              <div className="actions">
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
  useTitle(data ? `${data.listing.title} · Lintel` : 'Listing · Lintel');

  useEffect(() => { relay('GET', `/listings/${id}`).then(setData).catch((e) => setErr(e.message)); }, [id]);

  useEffect(() => {
    if (!data || data.listing.version === 2 || boot.state !== 'ready' || verify.state !== 'idle') return;
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

  if (err && !data) return <section className="narrow"><a href="#/" className="back">← Market</a><p className="error" role="alert">{err}</p></section>;
  if (!data) return <section className="narrow"><p className="muted">Loading the listing…</p></section>;
  if (data.listing.version === 2) {
    return <ListingV2 data={data} boot={boot} Steps={Steps} Notice={Notice} reload={() => relay('GET', `/listings/${id}`).then(setData).catch(() => {})} />;
  }
  const L = data.listing;
  const chainActive = store.get().buying[id]?.mode === 'chain';
  const canBuy = verify.state === 'ok' && L.status === 'open' && !isMine && !steps && !chainActive;
  const onchainDone = (bytes) => {
    relay('GET', `/listings/${id}`).then(setData).catch(() => {});
    const text = (() => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; } })();
    setResult({ bytes, text, name: L.filename || `${L.title.replace(/[^\w-]+/g, '_')}.txt` });
  };

  return (
    <section className="narrow">
      <a href="#/" className="back">← Market</a>
      <div className="row title-row"><h1>{L.title}</h1><Amt v={L.price_zec} big /></div>
      {L.description && <p className="lede">{L.description}</p>}
      <dl className="facts">
        <dt>Sealed size</dt><dd className="mono">{fmtBytes(L.size)}{L.filename ? ` · ${L.filename}` : ''}</dd>
        <dt>Content hash</dt><dd className="mono" title={L.content_hash}>{short(L.content_hash)}</dd>
        <dt>Unlock point T</dt><dd className="mono" title={L.t_point}>{short(L.t_point)}</dd>
        <dt>Status</dt><dd><span className={`tag ${L.status}`}>{L.status}</span></dd>
      </dl>

      <div className={`proof ${verify.state}`} role="status">
        <div>
          {verify.state === 'idle' && 'Waiting for the prover…'}
          {verify.state === 'run' && 'Verifying the Halo 2 proof on this device…'}
          {verify.state === 'ok' && <><b>Proof verified</b> in <span className="mono">{verify.ms} ms</span>. The file matches the listing: under the secret behind T, the ciphertext decrypts to content with this exact hash.</>}
          {verify.state === 'bad' && <><b>Proof rejected:</b> {verify.error}. Do not buy.</>}
        </div>
      </div>

      <Notice />
      {isMine && <p className="muted">This is your listing. Keep <a href="#/mine">My sales</a> open to serve buyers.</p>}
      {canBuy && <div className="actionbar"><button className="btn ghost" onClick={buy}>Buy off-chain demo (no ZEC moves)</button></div>}
      {!isMine && !steps && verify.state === 'ok' && (L.status === 'open' || chainActive) && !result && (
        <OnchainBuy listing={L} verifiedT={verify.t} boot={boot} onDone={onchainDone} />
      )}
      {L.status !== 'open' && !steps && !isMine && !chainActive && <p className="muted">This listing already has a buyer.</p>}
      {steps && <Steps steps={steps} />}
      {steps && !result && !err && <p className="muted small">Keep this tab open until the content unlocks.</p>}
      {err && <p className="error" role="alert">{err}</p>}

      {result && (
        <div className="unlocked">
          <div className="label ok-text">Settled · decrypted on this device</div>
          <h2>Unlocked</h2>
          {result.text !== null ? <pre>{result.text}</pre> : <p className="muted">Binary file, <span className="mono">{fmtBytes(result.bytes.length)}</span>.</p>}
          <button className="btn ghost" onClick={download}>Download</button>
        </div>
      )}
    </section>
  );
}
