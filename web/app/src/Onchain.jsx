// UI for in-browser on-chain settlement (Zcash testnet). Logic in onchain.js.
import { useEffect, useRef, useState } from 'react';
import { crypto, store, sleep } from './api.js';
import { useTitle } from './site.jsx';
import qrcode from 'qrcode-generator';
import { wallet, payin, fmtZec, zats, escrowFor, LOCK_VALUE, FUND_FEE, startBuyer, advanceBuyer, broadcastRefund, refundStatus } from './onchain.js';

/** QR code of `text` as SVG (generated here: no network, no innerHTML). */
export function Qr({ text, size = 220 }) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount(), m = 4, cells = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) cells.push(`M${c + m},${r + m}h1v1h-1z`);
  return (
    <svg className="qr" role="img" aria-label="Payment request QR code" width={size} height={size} viewBox={`0 0 ${n + 2 * m} ${n + 2 * m}`} shapeRendering="crispEdges">
      <rect width="100%" height="100%" fill="#fff" /><path d={cells.join('')} fill="#000" />
    </svg>
  );
}

const copy = (t) => navigator.clipboard?.writeText(t).catch(() => {});
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Balance + withdraw for one pay-in wallet (refund, change and the lock coin come back here). */
export function PayinFunds({ lid, compact }) {
  const [p, setP] = useState(() => payin.get(lid));
  const [dest, setDest] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (f) => { setBusy(true); setMsg(''); try { const m = await f(); if (m) setMsg(m); } catch (e) { setMsg(e.message); } setP(payin.get(lid)); setBusy(false); };
  if (!p) return null;
  const bal = payin.balance(lid);
  return (
    <div className="payin-funds small">
      {!compact && <div className="row title-row"><b>{p.title || p.listing}</b></div>}
      <p>Pay-in wallet: <span className="amt">{fmtZec(bal)}<span className="unit">TAZ</span></span> <span className="muted">spendable (checked to block {Number(p.scanned).toLocaleString('en-US')})</span></p>
      <div className="form">
        <button className="btn ghost sm" disabled={busy} onClick={() => run(async () => { const st = await payin.scan(lid); return `Checked to block ${st.scanned.toLocaleString('en-US')}: ${fmtZec(st.have)} TAZ spendable`; })}>Scan</button>
        <label><span className="label">Withdraw everything to</span>
          <input className="mono" value={dest} onChange={(e) => setDest(e.target.value)} placeholder="utest1… or tm… (any testnet wallet)" />
        </label>
        <button className="btn ghost sm" disabled={busy || !dest || bal === 0} onClick={() => run(async () => { const r = await payin.withdraw(lid, dest); return `Sent ${fmtZec(r.value)} TAZ (fee ${fmtZec(r.fee)}): ${r.txid}${r.more ? '. More notes remain: scan after it is mined and withdraw again.' : ''}`; })}>Withdraw</button>
        <button className="link" onClick={() => download(`lintel-payin-${lid}.SECRET.json`, payin.backup(lid))}>Download backup (secret keys)</button>
      </div>
      {msg && <p className="msg" role="status" style={{ overflowWrap: 'anywhere' }}>{msg}</p>}
    </div>
  );
}

/** The ZIP 321 request for a listing's pay-in wallet, polled until the payment is mined. */
function PayinRequest({ listing, onPaid }) {
  const [p] = useState(() => payin.get(listing.id));
  const [st, setSt] = useState(null);
  const [err, setErr] = useState('');
  const [alt, setAlt] = useState(false);
  useEffect(() => {
    let stop = false;
    (async () => {
      while (!stop) {
        try {
          const r = await payin.scan(listing.id);
          if (stop) return;
          setSt(r); setErr('');
          if (r.paid) { onPaid(); return; }
        } catch (e) { if (!stop) setErr(e.message); }
        await sleep(15000);
      }
    })();
    return () => { stop = true; };
  }, [listing.id]); // eslint-disable-line
  const uri = alt ? p.uri_t : p.uri;
  const addr = alt ? p.taddr : p.payment_ua;
  return (
    <div className="payin">
      <p className="small">
        Pay <span className="amt">{fmtZec(p.amount)}<span className="unit">TAZ</span></span> from any Zcash testnet wallet:
        the escrow ({fmtZec(p.escrowValue)}) + the lock coin ({fmtZec(LOCK_VALUE)}, returned to you) + the funding fee ({fmtZec(p.amount - p.escrowValue - LOCK_VALUE)}).
        Shielded (NU6.3, Ironwood) wallets pay privately; transparent-only wallets work too.
      </p>
      <div className="payin-qr"><Qr text={uri} /></div>
      <dl className="facts">
        <dt>Amount</dt><dd className="mono">{fmtZec(p.amount)} TAZ <button className="link" onClick={() => copy(fmtZec(p.amount))}>copy</button></dd>
        <dt>{alt ? 't-address' : 'Address'}</dt><dd className="mono small" style={{ overflowWrap: 'anywhere' }}>{addr} <button className="link" onClick={() => copy(addr)}>copy</button></dd>
        <dt>Request</dt><dd className="mono small" style={{ overflowWrap: 'anywhere' }}><a href={uri}>{uri.slice(0, 48)}…</a> <button className="link" onClick={() => copy(uri)}>copy</button></dd>
      </dl>
      <p className="small"><button className="link" onClick={() => setAlt(!alt)}>{alt ? 'Show the unified address (recommended)' : 'Wallet cannot read unified addresses? Use the t-address'}</button></p>
      <p className="small muted" aria-live="polite">
        {!st ? 'Watching the chain for your payment…'
          : st.paid ? 'Payment confirmed. Starting the purchase…'
          : `Received ${fmtZec(st.have)} of ${fmtZec(st.need)} TAZ (mined payments only; checked to block ${st.scanned.toLocaleString('en-US')}). Checking every 15 s.`}
      </p>
      <p className="small muted">
        The pay-in wallet's keys are stored in this browser only. If the sale does not go ahead nothing is lost: withdraw the
        funds from the Wallet page at any time. <button className="link" onClick={() => download(`lintel-payin-${listing.id}.SECRET.json`, payin.backup(listing.id))}>Download a backup</button> before
        paying if this browser's storage might be cleared.
      </p>
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}


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
      {avail === true && <PayinWallets />}
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

  async function start(opts) {
    setErr('');
    try { await startBuyer(listing, opts); setLog([opts?.fromPayin ? 'Payment received; joined the sale in on-chain mode' : 'Joined the sale in on-chain mode']); setPhase('joined'); loop(); }
    catch (e) { setErr(e.message); }
  }
  const [payOpen, setPayOpen] = useState(() => !active && !!payin.get(listing.id));
  async function openPayin() {
    setErr('');
    try { await payin.open(listing); setPayOpen(true); } catch (e) { setErr(e.message); }
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
          {!w && !payOpen && <p className="small">To pay from this device, <a href="#/wallet">create a testnet wallet</a>, or pay from any other testnet wallet.</p>}
          {w && !payOpen && wallet.spendable().every((n) => n.value < need) && <p className="small error">You need one wallet note of at least <span className="mono">{fmtZec(need)} TAZ</span>. <a href="#/wallet">Open the wallet</a>.</p>}
          {!payOpen && (
            <div className="row">
              <button className="btn" disabled={!w || !verifiedT || listing.status !== 'open'} onClick={() => start()}>Buy with this device's wallet</button>
              <button className="btn ghost" disabled={!verifiedT || listing.status !== 'open'} onClick={openPayin}>Pay from another wallet</button>
            </div>
          )}
          {payOpen && <PayinRequest listing={listing} onPaid={() => start({ fromPayin: true })} />}
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
      {active && entry?.chain?.source === 'payin' && (phase === 'done' || refund?.broadcast) && <PayinFunds lid={listing.id} compact />}
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}


/** Every pay-in wallet on this device ("pay from another wallet"), with import of a backup. */
function PayinWallets() {
  const [all, setAll] = useState(() => payin.all());
  const [imp, setImp] = useState('');
  const [msg, setMsg] = useState('');
  const ids = Object.keys(all);
  return (
    <>
      <h2>Pay-in wallets</h2>
      <p className="small muted">One per purchase paid from another wallet. Refunds, settlement change and the returned lock coin land here; withdraw them to any testnet wallet.</p>
      {ids.length === 0 && <p className="muted small">None on this device.</p>}
      {ids.map((id) => <PayinFunds key={id} lid={id} />)}
      <div className="form">
        <label><span className="label">Import a pay-in backup</span>
          <textarea className="mono" rows={2} value={imp} onChange={(e) => setImp(e.target.value)} placeholder="contents of lintel-payin-….SECRET.json" />
        </label>
        <button className="btn ghost sm" disabled={!imp} onClick={() => { try { payin.importBackup(imp); setImp(''); setAll(payin.all()); setMsg('Imported. Scan it to find its funds.'); } catch (e) { setMsg(e.message); } }}>Import</button>
      </div>
      {msg && <p className="msg" role="status">{msg}</p>}
    </>
  );
}
