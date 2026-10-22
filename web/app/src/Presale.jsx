// UI for presale (v2) listings: buyer page, purchases, and the seller's
// listing card. Protocol logic lives in presale.js.
import { useEffect, useRef, useState } from 'react';
import { relay, store } from './api.js';
import { useTitle } from './site.jsx';
import { orderV2, awaitUnlock, purchases, verifyListing, addCopies, MAX_COPIES } from './presale.js';

const short = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '');
const fmtBytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

export function copiesLabel(l) {
  if (l.units_total === undefined) return null;
  return l.units_open > 0 ? `${l.units_open} of ${l.units_total} left` : l.units_sold === l.units_total ? 'sold out' : 'all copies reserved';
}

const ORDER_TEXT = {
  awaiting_seller: 'Your side is done. Waiting for the seller’s device to come online and complete it. You can close this tab.',
  complete: 'The seller completed the signature.',
  rejected: 'The seller rejected the order.',
};

export function ListingV2({ data, boot, Steps, Notice, reload }) {
  const L = data.listing;
  const isMine = !!store.get().selling[L.id];
  const [verify, setVerify] = useState({ state: 'idle' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [mine, setMine] = useState(() => purchases(L.id));
  const [status, setStatus] = useState({});
  const [results, setResults] = useState({});
  const watching = useRef(new Set());

  useEffect(() => {
    if (boot.state !== 'ready' || verify.state !== 'idle') return;
    setVerify({ state: 'run' });
    verifyListing(L).then((r) => setVerify({ state: 'ok', ...r })).catch((e) => setVerify({ state: 'bad', error: e.message }));
  }, [boot.state, verify.state, L]);

  // Resume every purchase of this listing stored on this device.
  useEffect(() => {
    if (boot.state !== 'ready') return;
    const ctl = new AbortController();
    for (const p of mine) {
      if (watching.current.has(p.id)) continue;
      watching.current.add(p.id);
      awaitUnlock(p, { signal: ctl.signal, onStatus: (s) => setStatus((x) => ({ ...x, [p.id]: s })) })
        .then((bytes) => {
          const text = (() => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; } })();
          setResults((x) => ({ ...x, [p.id]: { bytes, text, name: p.filename || `${p.title.replace(/[^\w-]+/g, '_')}.txt` } }));
          reload();
        })
        .catch((e) => { if (e.message !== 'stopped') setStatus((x) => ({ ...x, [p.id]: `error: ${e.message}` })); })
        .finally(() => watching.current.delete(p.id));
    }
    return () => ctl.abort();
  }, [boot.state, mine]);

  async function buy() {
    setErr(''); setBusy(true);
    try {
      await orderV2(L);
      setMine(purchases(L.id));
      reload();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  const download = (r) => {
    const url = URL.createObjectURL(new Blob([r.bytes]));
    const a = Object.assign(document.createElement('a'), { href: url, download: r.name });
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const canBuy = verify.state === 'ok' && L.units_open > 0 && !isMine && !busy;
  useTitle(`${L.title} · Lintel`);
  return (
    <section className="narrow">
      <a href="#/" className="back">← Market</a>
      <div className="row title-row"><h1>{L.title}</h1><span className="amt big">{L.price_zec}<span className="unit">ZEC</span></span></div>
      {L.description && <p className="lede">{L.description}</p>}
      <dl className="facts">
        <dt>Sealed size</dt><dd className="mono">{fmtBytes(L.size)}{L.filename ? ` · ${L.filename}` : ''}</dd>
        <dt>Content hash</dt><dd className="mono" title={L.content_hash}>{short(L.content_hash)}</dd>
        <dt>Copies</dt><dd>{copiesLabel(L)} <span className="muted small">· each copy has its own unlock key</span></dd>
        <dt>Status</dt><dd><span className={`tag ${L.status}`}>{L.status}</span></dd>
      </dl>
      <div className={`proof ${verify.state}`} role="status">
        <div>
          {verify.state === 'idle' && 'Waiting for the prover…'}
          {verify.state === 'run' && 'Verifying the Halo 2 proof on this device…'}
          {verify.state === 'ok' && <><b>Proof verified</b> in <span className="mono">{verify.ms} ms</span> ({verify.parts} part{verify.parts > 1 ? 's' : ''}). The file matches the listing: each copy decrypts, under its own unlock secret, to content with this exact hash. The copy you order is checked again before you pre-sign.</>}
          {verify.state === 'bad' && <><b>Proof rejected:</b> {verify.error}. Do not buy.</>}
        </div>
      </div>
      <Notice />
      {isMine && <p className="muted">This is your listing. Sales complete on their own whenever this app is open on this device.</p>}
      {canBuy && <div className="actionbar"><button className="btn" onClick={buy}>Buy a copy for {L.price_zec} ZEC</button></div>}
      {busy && <p className="muted small" role="status">Checking the copy and pre-signing…</p>}
      {!isMine && L.units_open === 0 && mine.length === 0 && <p className="muted">No copies left right now.</p>}
      {err && <p className="error" role="alert">{err}</p>}
      {mine.map((p) => (
        <div key={p.id} className="card">
          <div className="row"><b>Your copy <span className="mono">#{p.unit + 1}</span></b>{results[p.id] && <span className="chip ok">Unlocked</span>}</div>
          <Steps steps={[
            ['Verify the proof, pre-sign, send the order', 'done', 'The seller did not need to be online'],
            ['Seller completes the signature', status[p.id] === 'complete' || results[p.id] ? 'done' : String(status[p.id] || '').startsWith('error') || status[p.id] === 'rejected' ? 'fail' : 'run', ORDER_TEXT[status[p.id]] || status[p.id]],
            ['Extract this copy’s secret and decrypt', results[p.id] ? 'done' : 'wait'],
          ]} />
          {results[p.id] && (
            <div className="unlocked">
              {results[p.id].text !== null ? <pre>{results[p.id].text}</pre> : <p className="muted">Binary file, <span className="mono">{fmtBytes(results[p.id].bytes.length)}</span>.</p>}
              <button className="btn ghost" onClick={() => download(results[p.id])}>Download</button>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

const ORDER_SELLER = { awaiting_seller: 'waiting for your device', complete: 'sold', rejected: 'rejected' };

/** Seller card for a v2 listing on "My sales". `agent` is the latest background pass. */
export function SellerCardV2({ id, entry, agent, onForget, boot }) {
  const l = agent?.listing;
  const orders = agent?.orders || [];
  const [adding, setAdding] = useState(null);
  const [form, setForm] = useState({ copies: 1, text: '', file: null });

  async function add(e) {
    e.preventDefault();
    setAdding({ note: 'Sealing…' });
    try {
      const payload = form.file ? new Uint8Array(await form.file.arrayBuffer()) : new TextEncoder().encode(form.text);
      await addCopies({ listingId: id, payload, copies: Number(form.copies), onStep: (i, n, ms) => setAdding({ note: `Sealed copy ${i}/${n} in ${(ms / 1000).toFixed(1)}s` }),
        onPart: (i, n, p) => setAdding({ note: p.uploaded !== undefined ? `Copy ${i}/${n}: uploading parts ${p.uploaded}/${p.blobs}` : `Copy ${i}/${n}: part ${p.part}/${p.parts} proven` }) });
      setAdding({ note: 'Added.', done: true });
    } catch (e2) { setAdding({ error: e2.message }); }
  }

  return (
    <div className="card">
      <div className="row title-row"><b>{entry.title}</b>{l && <span className="amt">{l.price_zec}<span className="unit">ZEC</span></span>}</div>
      <p><span className={`chip ${l && l.units_sold > 0 ? 'ok' : ''}`}>{l ? copiesLabel(l) : 'Checking'}</span>{agent?.completed ? <span className="small muted"> · completed {agent.completed} just now</span> : ''}</p>
      {orders.length > 0 && (
        <ul className="small muted">
          {orders.map((o) => <li key={o.id}>Copy #{o.unit + 1}: {ORDER_SELLER[o.status] || o.status}</li>)}
        </ul>
      )}
      {agent?.errors?.map((e, i) => <p key={i} className="small error">{e}</p>)}
      {adding && !adding.done && !adding.error && adding.note && <p className="small muted">{adding.note}</p>}
      {adding?.error && <p className="small error">{adding.error}</p>}
      {adding?.form && (
        <form onSubmit={add} className="form small">
          <label><span className="label">Copies to add</span><input className="mono" type="number" min={1} max={MAX_COPIES} value={form.copies} onChange={(e) => setForm({ ...form, copies: e.target.value })} /></label>
          <label><span className="label">Same content again</span><span className="small muted">Checked against the listing hash, never stored.</span>
            <textarea className="mono" rows={3} disabled={!!form.file} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} />
          </label>
          <label className="file"><span className="label">Or the same file</span><input type="file" onChange={(e) => setForm({ ...form, file: e.target.files[0] || null })} /></label>
          <button className="btn ghost" disabled={boot.state !== 'ready'}>Seal and add</button>
        </form>
      )}
      <div className="actions">
        <a href={`#/listing/${id}`}>View listing</a>
        <button className="link" onClick={() => setAdding({ form: true })}>Add copies</button>
        <button className="link danger" onClick={() => onForget(id)}>Forget keys</button>
      </div>
    </div>
  );
}

/** Buyer's purchases across listings (resumable after reload). */
export function Purchases() {
  const list = purchases();
  if (!list.length) return null;
  return (
    <>
      <h2>My purchases</h2>
      <div className="grid">
        {list.map((p) => (
          <a key={p.id} className="card" href={`#/listing/${p.listingId}`}>
            <b>{p.title}</b>
            <div className="meta"><span className="mono">Copy #{p.unit + 1}</span><span className={`chip ${p.unlocked ? 'ok' : 'pending'}`}>{p.unlocked ? 'unlocked' : 'waiting for seller'}</span></div>
          </a>
        ))}
      </div>
    </>
  );
}

export async function fetchListing(id) { return relay('GET', `/listings/${id}`); }
