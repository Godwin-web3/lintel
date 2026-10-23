// Site pages beside the landing: /how-it-works, /use-cases, /evidence.
// Summaries only; the docs (/docs) carry the detail and are linked from each section.
import { Link, SiteHeader, SiteFooter, useTitle, GITHUB, PUBLIC_RELAY } from './site.jsx';
import { RUNS, n } from './evidence.js';

export function Page({ active, label, title, lede, children }) {
  return (
    <div className="site">
      <SiteHeader active={active} />
      <main id="content">
        <section className="pagehero">
          <div className="wrap">
            <div className="label">{label}</div>
            <h1 className="display">{title}</h1>
            <p className="lede">{lede}</p>
          </div>
        </section>
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}

export function Band({ id, label, title, intro, children }) {
  return (
    <section className="band" id={id}>
      <div className="wrap">
        <div className="band-head">
          <div>
            <div className="label">{label}</div>
            <h2>{title}</h2>
          </div>
          {intro && <p>{intro}</p>}
        </div>
        {children}
      </div>
    </section>
  );
}

export function Next({ title, children }) {
  return (
    <section className="closing short">
      <div className="wrap">
        <h2 className="display">{title}</h2>
        <div className="ctas">{children}</div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- /how-it-works

function Trilithon() {
  // Brand mark geometry on its 96-unit grid, scaled 4x (beam 80x17, posts 21x49,
  // 6-unit reveal), with quiet annotations. Fills come from the brand tokens.
  return (
    <figure className="tri-figure" aria-label="Diagram: two posts carry one beam. The posts are the buyer's and seller's key shares; the beam is the settlement signature that reveals the key.">
      <svg viewBox="0 0 400 372" role="img" aria-hidden="true">
        <text x="40" y="38">Beam · the settlement</text>
        <rect className="beam" x="40" y="56" width="320" height="68" />
        <text x="200" y="97" textAnchor="middle" className="v on-beam">s = s_a + s_b + t</text>
        <rect className="post" x="76" y="148" width="84" height="196" />
        <rect className="post" x="240" y="148" width="84" height="196" />
        <text x="200" y="254" textAnchor="middle" className="v">t</text>
        <line className="gap" x1="166" y1="344" x2="234" y2="344" strokeDasharray="2 4" />
        <text x="118" y="368" textAnchor="middle">Buyer</text>
        <text x="282" y="368" textAnchor="middle">Seller</text>
      </svg>
    </figure>
  );
}

export function HowItWorks() {
  useTitle('How it works · Lintel');
  return (
    <Page active="/how-it-works" label="How it works" title={<>Paid and unlocked in <em>one</em> transaction.</>}
      lede="A zero-knowledge proof, a shielded escrow and an adaptor signature, all locked to the same secret. Here is how they fit, what they guarantee and where they stop.">
      <Band id="steps" label="Three steps" title="Nobody in the middle holds the key."
        intro={<>The proof, the escrow and the key exchange are one construction: an adaptor signature locked to the same secret <code>t</code> that encrypts the file. <Link to="/docs/how-it-works">The protocol, step by step</Link></>}>
        <div className="steps3">
          <div>
            <span className="num">01</span>
            <h3>Seal and prove</h3>
            <p>The seller encrypts the content on their device under a fresh secret <code>t</code> and publishes Halo 2 proofs: this ciphertext decrypts, under the secret behind <code>T</code>, to content with this hash. Every byte’s decryption is proven, up to 1,523,681 bytes.</p>
            <p className="tech">T = [t]·G · c<sub>i</sub> = m<sub>i</sub> + Poseidon(t, i+1) · Poseidon(m) = h</p>
          </div>
          <div>
            <span className="num">02</span>
            <h3>Pay into escrow</h3>
            <p>The buyer verifies the proofs on their device, then funds a joint escrow that neither side can spend alone. A time-locked refund is co-signed before any money moves.</p>
            <p className="tech">ak = vk_buyer + vk_seller · refund time-locked past the claim window</p>
          </div>
          <div>
            <span className="num">03</span>
            <h3>Settlement reveals the key</h3>
            <p>To get paid, the seller completes the adaptor signature and broadcasts it. The buyer reads <code>t</code> from the mined transaction and decrypts. No one has to hand anything over.</p>
            <p className="tech">t = s − s_a − s_b</p>
          </div>
        </div>
      </Band>

      <Band id="paying" label="Paying and selling" title="Pay from any wallet. Sell with the tab closed."
        intro="On-chain sales are single-copy listings on Zcash testnet. Both sides have a choice of how to take part.">
        <div className="two">
          <div className="panel">
            <h3>Buyers</h3>
            <ul className="ticks plain">
              <li><b>Device wallet.</b> A minimal testnet wallet kept in this browser funds the escrow directly. It knows only the notes you scan in by txid.</li>
              <li><b>Pay from another wallet.</b> The app shows a ZIP 321 request (QR and URI) to a per-purchase pay-in wallet. Pay it from any Zcash testnet wallet, shielded (Orchard receiver, Ironwood note) or transparent; the escrow is funded straight from that payment and leftovers can be withdrawn. <Link to="/docs/onchain#pay-from-another-wallet">Details</Link></li>
            </ul>
          </div>
          <div className="panel">
            <h3>Sellers</h3>
            <ul className="ticks plain">
              <li><b>Keep My sales open.</b> Your app co-signs the buyer’s refund before they fund, then builds and broadcasts the settlement.</li>
              <li><b>Hand off to the seller agent.</b> <code>lintel-agent</code> imports a handoff file from My sales and finishes the sale with your browser closed: refund, settlement, broadcast. It runs on a machine you control. <Link to="/docs/cli#lintel-agent-seller-agent">Usage</Link></li>
              <li><b>Multi-copy listings.</b> Buyers order and pre-sign while you are away; each sale completes the next time your app is open. These settle off-chain.</li>
            </ul>
          </div>
        </div>
      </Band>

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

      <Band id="guarantees" label="Guarantees and limits" title="What the math says, and where it stops."
        intro={<>Lintel is a working testnet system, not a finished product. These are the properties it enforces today and the ones it does not. <Link to="/docs/security-model">Security model</Link></>}>
        <div className="two">
          <div className="panel">
            <h3><span className="chip ok">Enforced</span></h3>
            <ul className="ticks good">
              <li><b>Proof before payment.</b> A wrong file, tampered ciphertext, a missing or swapped part, or a key not bound to the payment all fail verification on the buyer’s device.</li>
              <li><b>Claims are proven, not promised.</b> A seller can add public claims (starts with <code>%PDF</code>, length between two bounds, given bytes at an offset). They are proven in the same proof as the decryption, over the same bytes; a changed or false claim fails. <Link to="/docs/predicates">Proven claims</Link></li>
              <li><b>Neither side settles alone.</b> The escrow’s spend key is the sum of both shares; a spend needs a signature only both together can make.</li>
              <li><b>The key comes from the chain.</b> The buyer extracts <code>t</code> from the mined settlement and verifies the signature itself. The relay is not trusted for it.</li>
              <li><b>A refund exists before funding.</b> Consensus rejects it until the settlement window closes, so the refund and the settlement are never valid at the same height.</li>
              <li><b>Secrets stay with their owner.</b> Key shares, <code>t</code> and plaintext never reach the relay; it carries public data only.</li>
            </ul>
          </div>
          <div className="panel">
            <h3><span className="chip">Limits</span></h3>
            <ul className="ticks limit">
              <li><b>Testnet only, unaudited.</b> It runs on Zcash testnet with TAZ, which has no value.</li>
              <li><b>Someone must act for the seller.</b> The seller’s open app or a running <code>lintel-agent</code> co-signs the refund and broadcasts the settlement before it expires. There is no hosted agent.</li>
              <li><b>Refund only after the lock height.</b> If the seller never settles, the buyer waits about 60 blocks (roughly 75 minutes), then broadcasts the refund kept in that browser.</li>
              <li><b>Multi-copy listings settle off-chain.</b> On-chain settlement covers single-copy listings; multi-copy sales complete through the relay and move no TAZ.</li>
              <li><b>Big files are slow to seal in a browser.</b> About 100 s per 23.8 KB part in a single-threaded tab, so over an hour for 1 MB. Natively, 1 MB took 9.5 minutes on 2 vCPU. Verifying is fast.</li>
              <li><b>A hash is not a review.</b> The proof shows the content matches the agreed hash, and any proven claims hold, not that it is worth the price. Claims cover the first 23.8 KB part and are public.</li>
            </ul>
          </div>
        </div>
      </Band>

      <Band id="stack" label="Built on" title="Shielded money, transparent setup, local compute." intro={<>No new chain, no trusted setup, no server-side keys. <Link to="/docs/architecture">Architecture</Link></>}>
        <div className="stack">
          <div><span className="label">Settlement</span><h3>Zcash · NU7 testnet</h3><p>The escrow is a shielded note in the Ironwood pool, built as v6 transactions with RedPallas spend authorization, as in Orchard. The refund’s time lock is a transparent lock coin with <code>nLockTime</code>.</p></div>
          <div><span className="label">Proofs</span><h3>Halo 2</h3><p>IPA over the Pasta curves, so no trusted setup; the parameter files are pinned by digest. Small files take one proof of about 4.3 KB, which a browser verifies in about half a second. Larger files take one proof per 23.8 KB part.</p></div>
          <div><span className="label">Runtime</span><h3>WASM on your device</h3><p>The Rust engine compiles to WebAssembly and runs in a Web Worker. Proving, signing, transaction building and verification happen in the browser; the seller agent runs the same checks natively.</p></div>
        </div>
      </Band>

      <Next title={<>Read the <em>protocol</em>.</>}>
        <Link className="btn solid" to="/docs/how-it-works">Protocol in the docs</Link>
        <Link className="btn ghost" to="/docs/quickstart">Quickstart</Link>
      </Next>
    </Page>
  );
}

// ---------------------------------------------------------------- /use-cases

const USES = [
  ['Bug-bounty reports', 'Publish the hash of your report, then show the protocol a proof that the sealed report matches it. A proven claim can show the report names their contract address at a fixed offset. Payment and disclosure happen in one step, so neither side has to go first.'],
  ['Datasets', 'Sell a sample or a full dataset up to 1.5 MB with every byte proven. For something larger, sell the key to a file hosted anywhere: the proof then covers the key, not the file.'],
  ['Research', 'Release findings to whoever pays, with proof that the text is exactly the one you committed to earlier.'],
  ['Digital goods', 'Licence keys, access codes, files. On multi-copy listings each copy has its own unlock key, so one sale never opens another.'],
];

const SIZES = [
  ['Up to 1,953 bytes', 'One proof', 'About 3.3 s natively, 15 to 30 s in a browser', 'Keys, codes, short notes'],
  ['Up to 7,905 bytes', 'Up to four proofs (multi-copy listings)', 'Seconds per proof, as above', 'A short report or config'],
  ['Up to 1,523,681 bytes', 'One proof per 23,808-byte part, up to 64', '13.3 s per part natively on 2 vCPU; about 100 s per part in a single-threaded browser tab', 'Reports, archives, data samples'],
];

export function UseCases() {
  useTitle('Use cases · Lintel');
  return (
    <Page active="/use-cases" label="Use cases" title={<>For anything worth <em>proving</em> first.</>}
      lede="Lintel fits a sale where the buyer needs proof before paying and the seller needs payment before revealing. If you can state a hash for it, you can sell it sealed.">
      <Band id="uses" label="What people seal" title="Reports, data, research, keys.">
        <div className="uses">
          {USES.map(([h, p], i) => (
            <div key={h}><span className="label">{String(i + 1).padStart(2, '0')}</span><h3>{h}</h3><p>{p}</p></div>
          ))}
        </div>
      </Band>

      <Band id="sizes" label="How big" title="Up to 1.5 MB, every byte proven."
        intro={<>The app picks the proof format by size. Bigger files are split into proven parts whose ciphertext and proofs the relay stores by SHA-256. <Link to="/docs/big-payloads">Big payloads</Link></>}>
        <div className="tablewrap">
          <table className="evidence sizes">
            <thead><tr><th>Payload</th><th>Proofs</th><th>Sealing time (measured)</th><th>Typical</th></tr></thead>
            <tbody>
              {SIZES.map(([a, b, c, d]) => <tr key={a}><td className="mono">{a}</td><td>{b}</td><td>{c}</td><td className="muted">{d}</td></tr>)}
            </tbody>
          </table>
        </div>
        <p className="evnote">A 1 MB file is 43 parts: 9.5 minutes natively on a 2-core machine, over an hour in a single-threaded browser tab. Buying stays quick: verifying takes about 0.2 s per part natively and 1.5 s in the browser.</p>
      </Band>

      <Band id="kinds" label="Two kinds of listing" title="One copy on chain, or many off chain.">
        <div className="two">
          <div className="panel">
            <h3>Single copy · on-chain</h3>
            <p className="muted">Escrow, time-locked refund and settlement on Zcash testnet, priced in TAZ. The seller’s app or the seller agent finishes the sale. Buyers pay from the device wallet or any testnet wallet.</p>
          </div>
          <div className="panel">
            <h3>Multi-copy · off-chain</h3>
            <p className="muted">Up to 10 copies from the Sell form, each sealed with its own secret. Buyers order while the seller is away; the sale completes the next time the seller’s app is open. No coins move yet.</p>
          </div>
        </div>
      </Band>

      <Next title={<>Seal your <em>first</em> listing.</>}>
        <a className="btn solid" href="/app#/sell">Sell on testnet</a>
        <Link className="btn ghost" to="/docs/quickstart">Quickstart</Link>
      </Next>
    </Page>
  );
}

// ---------------------------------------------------------------- /evidence

const check = (txid) => `${PUBLIC_RELAY}/chain/tx/${txid}`;

export function Evidence() {
  useTitle('Testnet evidence · Lintel');
  const total = RUNS.reduce((a, r) => a + r.rows.length, 0);
  return (
    <Page active="/evidence" label="Live testnet evidence" title={<>Mined, not <em>mocked</em>.</>}
      lede={`${total} transactions on Zcash testnet (NU7, v6, Ironwood pool), from the public records in the repository. Each one opens on the public relay’s lightwalletd proxy, which returns the raw transaction and the block it was mined in.`}>
      <section className="band">
        <div className="wrap evruns">
          <nav className="evtoc" aria-label="Runs">
            <div className="label">Runs, newest first</div>
            <ul>{RUNS.map((r) => <li key={r.id}><a href={`#${r.id}`}>{r.what}</a></li>)}</ul>
          </nav>
          <div>
            {RUNS.map((r) => (
              <article className="evrun" id={r.id} key={r.id}>
                <header>
                  <span className="label">{r.date} 2026</span>
                  <h2>{r.what}</h2>
                  <p>{r.why}</p>
                </header>
                <table className="evidence">
                  <thead><tr><th>Step</th><th>Transaction id</th><th className="h">Block</th></tr></thead>
                  <tbody>
                    {r.rows.map((e) => (
                      <tr key={e.step + e.txid}>
                        <td className="what"><b>{e.step}</b></td>
                        <td><a className="txid" href={check(e.txid)} rel="noreferrer" title="Open on the public relay's chain proxy">{e.txid}</a></td>
                        <td className="h">{n(e.h)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </article>
            ))}
            <p className="evnote">
              Records: <a href={`${GITHUB}/tree/main/docs/testnet`} rel="noreferrer"><code>docs/testnet/*.json</code></a>.{' '}
              <code>lintel-chain verify-witness --txid …</code> checks a transaction against live chain data.{' '}
              <Link to="/docs/testnet-evidence">What each run did and how to reproduce it</Link>
            </p>
          </div>
        </div>
      </section>
    </Page>
  );
}
