// UI for in-browser on-chain settlement (Zcash testnet). Logic in onchain.js.
import { useEffect, useRef, useState } from 'react';
import { crypto, store, sleep } from './api.js';
import { useTitle } from './site.jsx';
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

  useTitle('Wallet · Lintel');
  return (
    <section className="narrow">
      <div className="label">Wallet · Zcash testnet</div>
      <h1>Testnet wallet</h1>
      <p className="lede">
        One Zcash testnet (TAZ) wallet on this device. It funds on-chain purchases and receives on-chain sales, and
        its spending key never leaves this browser. Fund it from a testnet faucet, then paste the faucet
        transaction id below so this device can find the note.
      </p>
      {avail === null && <p className="muted">Loading the on-chain engine…</p>}
      {avail !== null && avail !== true && <p className="error" role="alert">The on-chain engine is not available in this build: {avail}</p>}
      {avail === true && !w && (
        <div className="form">
          <button className="btn ghost" disabled={busy} onClick={() => run(async () => { await wallet.create(); return 'Wallet created on this device.'; })}>Create wallet</button>
          <label><span className="label">Or import a key</span>
            <span className="small muted">Hex, or the JSON written by <code>lintel-chain wallet</code>.</span>
            <textarea className="mono" rows={2} value={imp} onChange={(e) => setImp(e.target.value)} />
          </label>
          <button className="btn ghost" disabled={busy || !imp} onClick={() => run(async () => { await wallet.import(imp); setImp(''); return 'Key imported.'; })}>Import</button>
        </div>
      )}
      {avail === true && w && (
        <>
          <dl className="facts">
            <dt>Address</dt><dd className="mono small">{w.address}</dd>
            <dt>Spendable</dt><dd><span className="amt">{fmtZec(wallet.balance())}<span className="unit">TAZ</span></span> <span className="muted small">in {wallet.spendable().length} note{wallet.spendable().length === 1 ? '' : 's'}</span></dd>
          </dl>
          <div className="form">
            <label><span className="label">Add a payment to this wallet</span>
              <input className="mono" value={txid} onChange={(e) => setTxid(e.target.value.trim())} placeholder="txid of a mined transaction paying the address above" />
            </label>
            <button className="btn ghost" disabled={busy || !/^[0-9a-f]{64}$/.test(txid)} onClick={() => run(async () => { const f = await wallet.scan(txid); setTxid(''); return f.length ? `Found ${f.length} note(s): ${f.map((n) => fmtZec(n.value)).join(', ')} TAZ` : 'No notes for this wallet in that transaction.'; })}>Scan</button>
          </div>
          <h2>Notes</h2>
          {w.notes.length === 0 ? <p className="muted">No notes yet. Scan the txid of a payment to the address above.</p> : (
            <div className="tablewrap">
              <table className="notes">
                <thead><tr><th>Txid</th><th>Value</th><th>Block</th><th>State</th></tr></thead>
                <tbody>
                  {w.notes.map((n) => (
                    <tr key={n.cmx}><td>{n.txid.slice(0, 10)}…</td><td>{fmtZec(n.value)} <span className="muted">TAZ</span></td><td>{n.height ? n.height.toLocaleString('en-US') : '—'}</td><td>{n.spent ? 'spent' : n.reserved ? 'reserved' : 'unspent'}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="small" style={{ marginTop: 24 }}><button className="link danger" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'} spending key (secret)</button></p>
          {show && <pre className="secret">{JSON.stringify({ sk: w.sk })}</pre>}
        </>
      )}
      {msg && <p className="msg" role="status">{msg}</p>}
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
  if (avail !== true) return <p className="muted small">On-chain settlement is not available in this build ({avail}).</p>;
  return (
    <div className="onchain">
      <div className="label">Settle on Zcash testnet</div>
      <h2>Buy on-chain</h2>
      {!active && phase === 'idle' && (
        <>
          <dl className="facts">
            <dt>Escrow</dt><dd><span className="amt">{fmtZec(escrowFor(price))}<span className="unit">TAZ</span></span> <span className="muted small">price + fees</span></dd>
            <dt>Lock coin</dt><dd><span className="amt">{fmtZec(LOCK_VALUE)}<span className="unit">TAZ</span></span> <span className="muted small">returned to you</span></dd>
          </dl>
          <p className="small muted">
            Before you fund, the seller co-signs a refund that becomes valid only after their claim window closes.
            This device builds, signs and proves every transaction; the relay only forwards public data.
          </p>
          {!w && <p className="small">You need a testnet wallet first: <a href="#/wallet">create one</a>.</p>}
          {w && wallet.spendable().every((n) => n.value < need) && <p className="small error">You need one wallet note of at least <span className="mono">{fmtZec(need)} TAZ</span>. <a href="#/wallet">Open the wallet</a>.</p>}
          <button className="btn" disabled={!w || !verifiedT || listing.status !== 'open'} onClick={start}>Buy on-chain for {listing.price_zec} TAZ</button>
        </>
      )}
      {log.length > 0 && <ol className="log" aria-live="polite">{log.map((l, i) => <li key={i}>{l}</li>)}</ol>}
      {refund && !refund.broadcast && phase !== 'done' && (
        <div className="refund small">
          <p className="muted">
            Refund signed and stored on this device. It becomes valid after block <span className="mono">{Number(refund.lockHeight).toLocaleString('en-US')}</span> (chain tip <span className="mono">{Number(refund.tip).toLocaleString('en-US')}</span>).
          </p>
          {refund.ready && <button className="btn danger sm" onClick={doRefund}>Broadcast refund</button>}
        </div>
      )}
      {refund?.broadcast && <p className="small">Refund broadcast: <code style={{ overflowWrap: 'anywhere' }}>{refund.broadcast}</code></p>}
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}
