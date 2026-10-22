// Landing page (/). Every number here comes from the public testnet records
// in docs/testnet/*.json, imported at build time.
import { Link, SiteHeader, SiteFooter, useTitle } from './site.jsx';
import browserSettle from '../../../docs/testnet/evidence-browser-settle.json';
import browserRefund from '../../../docs/testnet/evidence-browser-refund.json';
import v2Refund from '../../../docs/testnet/evidence-v2-refund.json';
import cliSettle from '../../../docs/testnet/evidence-settle.json';

const n = (x) => Number(x).toLocaleString('en-US');

function Receipt() {
  const s = browserSettle;
  const secs = s.elapsed_s;
  return (
    <aside className="receipt" aria-label="Most recent browser sale on Zcash testnet">
      <header>
        <span className="label">Browser sale · Zcash testnet</span>
        <span className="chip ok">Settled</span>
      </header>
      <dl>
        <dt>Price</dt><dd><span className="amt">{s.price_taz}<span className="unit">TAZ</span></span></dd>
        <dt>Escrow funded</dt><dd>block {n(s.funding.height)}</dd>
        <dt>Settled</dt><dd>block {n(s.settlement.height)}</dd>
        <dt>Key source</dt><dd>mined tx</dd>
        <dt>Relay saw signature</dt><dd>{s.relay_saw_signature ? 'yes' : 'no'}</dd>
        <dt>Decrypted file matches</dt><dd className={s.decrypted_matches ? 'ok-text' : 'error'}>{String(s.decrypted_matches)}</dd>
      </dl>
      <footer>
        Both sides in the web app, {Math.floor(secs / 60)} min {secs % 60} s end to end.{' '}
        <Link to="/docs/testnet-evidence">See the record</Link>
      </footer>
    </aside>
  );
}

function Trilithon() {
  // Brand mark on its 96-unit grid, scaled 4x, with quiet annotations.
  return (
    <figure className="tri-figure" aria-label="Diagram: two posts carry one beam. The posts are the buyer's and seller's key shares; the beam is the settlement signature that reveals the key.">
      <svg viewBox="0 0 400 340" role="img" aria-hidden="true">
        <text x="40" y="38">Beam · the settlement</text>
        <rect x="40" y="56" width="320" height="68" fill="#F4B728" />
        <text x="200" y="97" textAnchor="middle" className="v" style={{ fill: '#0E0F11' }}>s = s_a + s_b + t</text>
        <rect x="76" y="148" width="84" height="164" fill="#ECE6DA" />
        <rect x="240" y="148" width="84" height="164" fill="#ECE6DA" />
        <text x="200" y="238" textAnchor="middle" className="v">t</text>
        <line x1="166" y1="312" x2="234" y2="312" stroke="#8C929C" strokeDasharray="2 4" />
        <text x="118" y="336" textAnchor="middle">Buyer</text>
        <text x="282" y="336" textAnchor="middle">Seller</text>
      </svg>
    </figure>
  );
}

const EVIDENCE = [
  { what: 'Browser sale: escrow funded', why: 'Buyer’s device wallet pays into the joint escrow, with a time-locked refund already co-signed.', txid: browserSettle.funding.txid, h: browserSettle.funding.height },
  { what: 'Browser sale: settlement', why: 'Seller’s browser broadcasts the adaptor-signed spend. The buyer’s browser read t from it and decrypted the file.', txid: browserSettle.settlement.txid, h: browserSettle.settlement.height },
  { what: 'Browser refund after the lock', why: `An escrow that never settled, returned with its pre-signed refund once the chain passed block ${n(browserRefund.n_lock_time)}.`, txid: browserRefund.refund_txid, h: browserRefund.refund_height },
  { what: 'Time lock enforced by consensus', why: `The same refund bytes were rejected before block ${n(v2Refund.claim_window.refund_first_valid_height)} and mined after it.`, txid: v2Refund.refund.txid, h: v2Refund.refund.height },
  { what: 'First two-party settlement (CLI)', why: 'Escrow note owned by the joint key; t recovered from the mined transaction.', txid: cliSettle.settlement.txid, h: cliSettle.settlement.height },
];

export default function Landing() {
  useTitle('Lintel · Pay to unlock, proven before you pay');
  return (
    <div className="site">
      <SiteHeader />
      <main id="content" style={{ padding: 0 }}>
        <section className="hero">
          <div className="wrap">
            <div>
              <div className="label">Zcash testnet · Open source</div>
              <h1 className="display"><span className="line">Pay to unlock.</span> <span className="line"><em>Proven</em> before you pay.</span></h1>
              <p className="lede">
                Lintel sells sealed files for Zcash. Before paying, the buyer’s browser checks a zero-knowledge
                proof that the ciphertext opens to exactly the content that was promised. The payment signature
                carries the key, so getting paid and unlocking the file are the same transaction.
              </p>
              <div className="ctas">
                <a className="btn" href="/app">Launch app</a>
                <Link className="btn ghost" to="/docs">Read the docs</Link>
              </div>
            </div>
            <Receipt />
          </div>
        </section>

        <section className="band" id="how">
          <div className="wrap">
            <div className="band-head">
              <div>
                <div className="label">How it works</div>
                <h2>Three steps. Nobody in the middle holds the key.</h2>
              </div>
              <p>
                The proof, the escrow and the key exchange are one construction: an adaptor signature locked to the
                same secret that encrypts the file. Every step runs on the buyer’s and seller’s own devices.
              </p>
            </div>
            <div className="steps3">
              <div>
                <span className="num">01</span>
                <h3>Seal and prove</h3>
                <p>The seller encrypts the content in their browser under a fresh secret <code>t</code> and publishes a Halo 2 proof: this ciphertext decrypts, under the secret behind <code>T</code>, to content with this hash.</p>
                <p className="tech">T = [t]·G · c<sub>i</sub> = m<sub>i</sub> + Poseidon(t, i+1) · Poseidon(m) = h</p>
              </div>
              <div>
                <span className="num">02</span>
                <h3>Pay into escrow</h3>
                <p>The buyer verifies the proof on their device, then funds a joint escrow that neither side can spend alone. A refund is co-signed before any money moves.</p>
                <p className="tech">ak = vk_buyer + vk_seller · refund time-locked past the claim window</p>
              </div>
              <div>
                <span className="num">03</span>
                <h3>Settlement reveals the key</h3>
                <p>To get paid, the seller completes the adaptor signature and broadcasts it. The buyer reads <code>t</code> from the mined transaction and decrypts. No one has to hand anything over.</p>
                <p className="tech">t = s − s_a − s_b</p>
              </div>
            </div>
          </div>
        </section>

        <section className="band" id="name">
          <div className="wrap tri">
            <Trilithon />
            <div>
              <div className="label">The name</div>
              <p className="quote display">Two posts. One beam.</p>
              <p className="lede">
                A lintel is the beam laid across two posts to make a doorway. It stands only when both posts carry
                it. Here, buyer and seller each hold half of an adaptor signature. Neither can settle alone, and the
                transaction that pays the seller is the one that hands the buyer the key.
              </p>
              <dl>
                <div><dt>Left post</dt><dd>The buyer’s key share. It pre-signs only after the proof checks out.</dd></div>
                <div><dt>Right post</dt><dd>The seller’s key share and the unlock secret <code>t</code>.</dd></div>
                <div><dt>Beam</dt><dd>The completed signature on chain. Valid only with both shares, and it reveals <code>t</code>.</dd></div>
              </dl>
            </div>
          </div>
        </section>

        <section className="band" id="guarantees">
          <div className="wrap">
            <div className="band-head">
              <div>
                <div className="label">Guarantees and limits</div>
                <h2>What the math says, and where it stops.</h2>
              </div>
              <p>Lintel is a working testnet system, not a finished product. These are the properties it enforces today and the ones it does not.</p>
            </div>
            <div className="two">
              <div className="panel">
                <h3><span className="chip ok">Enforced</span></h3>
                <ul className="ticks good">
                  <li><b>Proof before payment.</b> A wrong file, tampered ciphertext, or a key not bound to the payment all fail verification in the buyer’s browser.</li>
                  <li><b>Neither side settles alone.</b> The escrow’s spend key is the sum of both shares; a spend needs a signature only both together can make.</li>
                  <li><b>The key comes from the chain.</b> The buyer extracts <code>t</code> from the mined settlement and verifies the signature itself. The relay is not trusted for it.</li>
                  <li><b>A refund exists before funding.</b> Consensus rejects it until the settlement window closes, so the refund and the settlement are never valid at the same height.</li>
                  <li><b>Secrets stay on the device.</b> Key shares, <code>t</code> and plaintext never reach the relay; it carries public data only.</li>
                </ul>
              </div>
              <div className="panel">
                <h3><span className="chip error">Limits</span></h3>
                <ul className="ticks limit">
                  <li><b>Testnet only, unaudited.</b> It runs on Zcash testnet with TAZ, which has no value.</li>
                  <li><b>The seller must be online to settle.</b> Their open app co-signs the refund before the buyer funds, and must broadcast the settlement before it expires.</li>
                  <li><b>Refund only after the lock height.</b> If the seller disappears, the buyer waits about 60 blocks (roughly 75 minutes), then broadcasts the refund kept in that browser.</li>
                  <li><b>Multi-copy listings settle off-chain.</b> On-chain settlement covers single-copy listings; presale listings complete through the relay and move no ZEC.</li>
                  <li><b>A hash is not a review.</b> The proof shows the content matches the agreed hash, not that it is worth the price.</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section className="band" id="uses">
          <div className="wrap">
            <div className="band-head">
              <div>
                <div className="label">Use cases</div>
                <h2>For anything you can seal in a megabyte or so.</h2>
              </div>
              <p>Up to 1.5 MB per listing, on-chain or multi-copy, with every byte's decryption proven: small files in one proof, larger ones in proven 23 KB parts stored by content address. Enough for a report, a dataset sample, a PoC repo archive or a key.</p>
            </div>
            <div className="uses">
              <div><span className="label">01</span><h3>Bug-bounty reports</h3><p>Show the protocol a proof that your report matches the hash you published. Payment and disclosure happen in one step.</p></div>
              <div><span className="label">02</span><h3>Datasets</h3><p>Sell a dataset of up to 1.5 MB with every byte proven, or the decryption key to a larger one hosted anywhere (then only the key is proven). The buyer knows what they are getting before they pay.</p></div>
              <div><span className="label">03</span><h3>Research</h3><p>Release findings to whoever pays, with proof that the text is exactly the one you committed to.</p></div>
              <div><span className="label">04</span><h3>Digital goods</h3><p>Licence keys, access codes, files. Each copy has its own unlock key, so one sale never opens another.</p></div>
            </div>
          </div>
        </section>

        <section className="band" id="evidence">
          <div className="wrap">
            <div className="band-head">
              <div>
                <div className="label">Live testnet evidence</div>
                <h2>Mined, not mocked.</h2>
              </div>
              <p>Real Zcash testnet transactions (NU7, v6, Ironwood pool) from the public records in the repository.</p>
            </div>
            <table className="evidence">
              <thead><tr><th>What happened</th><th>Transaction id</th><th className="h">Block</th></tr></thead>
              <tbody>
                {EVIDENCE.map((e) => (
                  <tr key={e.txid}>
                    <td className="what"><b>{e.what}</b><span>{e.why}</span></td>
                    <td><span className="txid">{e.txid}</span></td>
                    <td className="h">{n(e.h)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="evnote">
              Look any of these up on a Zcash testnet node or lightwalletd; <code>lintel-chain verify-witness --txid …</code> checks a transaction against live chain data.{' '}
              <Link to="/docs/testnet-evidence">All records and how to reproduce them</Link>
            </p>
          </div>
        </section>

        <section className="band" id="stack">
          <div className="wrap">
            <div className="band-head">
              <div>
                <div className="label">Built on</div>
                <h2>Shielded money, transparent setup, local compute.</h2>
              </div>
              <p>No new chain, no trusted setup, no server-side keys.</p>
            </div>
            <div className="stack">
              <div><span className="label">Settlement</span><h3>Zcash Orchard · NU7</h3><p>The escrow is a shielded note in the Ironwood pool on the NU7 testnet, built as v6 transactions with RedPallas spend authorization, as in Orchard.</p></div>
              <div><span className="label">Proofs</span><h3>Halo 2</h3><p>Proofs over the Pasta curves with IPA, so there is no trusted setup. A sealed-content proof is about 4.3 KB; verifying one in the browser takes about half a second.</p></div>
              <div><span className="label">Runtime</span><h3>WASM in the browser</h3><p>The Rust engine compiles to WebAssembly and runs in a Web Worker. Proving, signing, transaction building and verification all happen on your device.</p></div>
            </div>
          </div>
        </section>

        <section className="closing">
          <div className="wrap">
            <div className="label">Try it on testnet</div>
            <h2 className="display">Sealed until <em>settled</em>.</h2>
            <div className="ctas">
              <a className="btn" href="/app">Launch app</a>
              <Link className="btn ghost" to="/docs/quickstart">Quickstart</Link>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
