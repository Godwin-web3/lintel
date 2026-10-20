// UI for in-browser on-chain settlement (Zcash testnet). Logic in onchain.js.
import { useEffect, useRef, useState } from 'react';
import { crypto, store, sleep } from './api.js';
import { wallet, fmtZec, zats, escrowFor, LOCK_VALUE, FUND_FEE, startBuyer, advanceBuyer, broadcastRefund, refundStatus } from './onchain.js';

export function useChainAvailable(boot) {
  const [ok, setOk] = useState(null);
  useEffect(() => {
    if (boot.state !== 'ready') return;
    crypto('chainAvailable').then((r) => setOk(r === true ? true : String(r))).catch((e) => setOk(e.message));
  }, [boot.state]);
  return ok;
}

export function WalletPanel({ boot }) {
  const avail = useChainAvailable(boot);
  const [w, setW] = useState(() => wallet.get());
  const [txid, setTxid] = useState('');
  const [imp, setImp] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const run = async (f) => { setBusy(true); setMsg(''); try { const m = await f(); if (m) setMsg(m); } catch (e) { setMsg(e.message); } setW(wallet.get()); setBusy(false); };

  return (
    <section className="narrow">
      <h1>Testnet wallet</h1>
      <p className="muted">
        One Zcash <b>testnet</b> (TAZ) wallet on this device, used to fund on-chain purchases and to receive on-chain
        sales. Its spending key never leaves this browser. Fund it from a testnet faucet, then paste the faucet
        transaction id below so this device can find the note.
      </p>
      {avail === null && <p className="muted">Loading the on-chain engine…</p>}
      {avail !== null && avail !== true && <p className="error">On-chain engine unavailable in this build: {avail}</p>}
      {avail === true && !w && (
        <div className="form">
          <button className="btn" disabled={busy} onClick={() => run(async () => { await wallet.create(); return 'Wallet created on this device'; })}>Create wallet</button>
          <label>Or import a key (hex, or <code>lintel-chain wallet</code> JSON)
            <textarea className="mono" rows={2} value={imp} onChange={(e) => setImp(e.target.value)} />
          </label>
          <button className="btn ghost" disabled={busy || !imp} onClick={() => run(async () => { await wallet.import(imp); setImp(''); return 'Imported'; })}>Import</button>
        </div>
      )}
      {avail === true && w && (
        <>
          <dl className="facts">
            <dt>Address</dt><dd className="mono small" style={{ wordBreak: 'break-all' }}>{w.address}</dd>
            <dt>Spendable</dt><dd>{fmtZec(wallet.balance())} TAZ in {wallet.spendable().length} note(s)</dd>
          </dl>
          <div className="form">
            <label>Add a payment to this wallet (txid)
              <input className="mono" value={txid} onChange={(e) => setTxid(e.target.value.trim())} placeholder="64-hex txid of a mined transaction paying the address above" />
            </label>
            <button className="btn" disabled={busy || !/^[0-9a-f]{64}$/.test(txid)} onClick={() => run(async () => { const f = await wallet.scan(txid); setTxid(''); return f.length ? `Found ${f.length} note(s): ${f.map((n) => fmtZec(n.value)).join(', ')} TAZ` : 'No notes for this wallet in that transaction'; })}>Scan</button>
          </div>
          <h2>Notes</h2>
          <table className="small"><tbody>
            {w.notes.map((n) => (
              <tr key={n.cmx}><td className="mono">{n.txid.slice(0, 10)}…</td><td>{fmtZec(n.value)} TAZ</td><td>block {n.height || '—'}</td><td>{n.spent ? 'spent' : n.reserved ? 'reserved' : 'unspent'}</td></tr>
            ))}
          </tbody></table>
          <p className="small"><button className="link" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'} spending key (secret)</button></p>
          {show && <pre className="mono small" style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>{JSON.stringify({ sk: w.sk })}</pre>}
        </>
      )}
      {msg && <p className="small">{msg}</p>}
    </section>
  );
}

/** Buyer panel for a v1 listing settled on chain. */
export function OnchainBuy({ listing, verifiedT, boot, onDone }) {
  const avail = useChainAvailable(boot);
  const entry = store.get().buying[listing.id];
  const active = entry?.mode === 'chain';
  const [log, setLog] = useState(() => (active ? ['Resuming on-chain purchase…'] : []));
  const [phase, setPhase] = useState(active ? 'resume' : 'idle');
  const [err, setErr] = useState('');
  const [refund, setRefund] = useState(null);
  const running = useRef(false);
  const w = wallet.get();
  const price = zats(listing.price_zec);
  const need = escrowFor(price) + LOCK_VALUE + FUND_FEE;

  async function loop() {
    if (running.current) return;
    running.current = true;
    let last = '';
    try {
      for (;;) {
        const r = await advanceBuyer(listing, verifiedT);
        if (r.note !== last) { last = r.note; setLog((l) => [...l, r.note]); }
        setPhase(r.phase); if (r.refund !== undefined) setRefund(r.refund);
        if (r.done) { onDone(r.plaintext); break; }
        await sleep(r.note.startsWith('Waiting') ? 8000 : 500);
      }
    } catch (e) { setErr(e.message); }
    running.current = false;
  }
  useEffect(() => { if (active && avail === true && verifiedT) loop(); }, [avail, verifiedT]); // eslint-disable-line

  async function start() {
    setErr('');
    try { await startBuyer(listing); setLog(['Joined the sale in on-chain mode']); setPhase('joined'); loop(); }
    catch (e) { setErr(e.message); }
  }
  async function doRefund() {
    setErr('');
    try { const txid = await broadcastRefund(listing.id); setLog((l) => [...l, `Refund broadcast: ${txid}`]); setRefund(await refundStatus(listing.id)); }
    catch (e) { setErr(e.message); }
  }

  if (avail === null) return null;
  if (avail !== true) return <p className="muted small">On-chain settlement unavailable in this build ({avail}).</p>;
  return (
    <div className="onchain">
      <h2>Settle on Zcash testnet</h2>
      {!active && phase === 'idle' && (
        <>
          <p className="small muted">
            Escrow {fmtZec(escrowFor(price))} TAZ (price + fees) plus a {fmtZec(LOCK_VALUE)} TAZ lock coin you get back.
            A refund is co-signed before you fund; it becomes valid only after the seller's claim window. This
            device builds, signs and proves every transaction; the relay only forwards public data.
          </p>
          {!w && <p className="small">Needs a testnet wallet: <a href="#/wallet">create one</a>.</p>}
          {w && wallet.spendable().every((n) => n.value < need) && <p className="small error">Needs one wallet note of at least {fmtZec(need)} TAZ (<a href="#/wallet">wallet</a>).</p>}
          <button className="btn" disabled={!w || !verifiedT || listing.status !== 'open'} onClick={start}>Buy on-chain for {listing.price_zec} TAZ</button>
        </>
      )}
      {log.length > 0 && <ol className="log small">{log.map((l, i) => <li key={i}>{l}</li>)}</ol>}
      {refund && !refund.broadcast && phase !== 'done' && (
        <p className="small muted">
          Refund signed and stored on this device; valid after block {refund.lockHeight} (tip {refund.tip}).{' '}
          {refund.ready && <button className="btn ghost" onClick={doRefund}>Broadcast refund</button>}
        </p>
      )}
      {refund?.broadcast && <p className="small">Refund broadcast: <code>{refund.broadcast}</code></p>}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
