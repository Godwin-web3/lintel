// Landing page (/): short on purpose. Hero, the three steps in brief, a few
// use cases and one call to action. Depth lives on /how-it-works, /use-cases,
// /evidence and /docs. Numbers come from docs/testnet/*.json via evidence.js.
import { Link, SiteHeader, SiteFooter, useTitle } from './site.jsx';
import { browserSettle, n } from './evidence.js';

function Receipt() {
  const s = browserSettle;
  const secs = s.elapsed_s;
  return (
    <aside className="receipt" aria-label="A browser sale on Zcash testnet">
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
        <Link to="/evidence">All testnet runs</Link>
      </footer>
    </aside>
  );
}

const STEPS = [
  ['Seal and prove', 'The seller encrypts the file on their device under a fresh secret and publishes a Halo 2 proof that the ciphertext opens to content with a stated hash. Every byte is covered, up to about 1.5 MB.'],
  ['Verify, then pay', 'The buyer checks the proof locally before any money moves, then pays into a shielded escrow neither side can spend alone. A time-locked refund is co-signed first.'],
  ['Settlement reveals the key', 'To get paid, the seller completes an adaptor signature. The mined transaction carries the key; the buyer reads it from the chain and decrypts.'],
];

const USES = [
  ['Bug-bounty reports', 'Prove the report matches the hash you published. Payment and disclosure are one step.'],
  ['Datasets', 'A sample or a full set up to 1.5 MB, every byte proven before the buyer pays.'],
  ['Research', 'Release findings to whoever pays, provably the exact text you committed to.'],
];

export default function Landing() {
  useTitle('Lintel · Pay only for what’s proven');
  return (
    <div className="site">
      <SiteHeader />
      <main id="content">
        <section className="hero">
          <div className="wrap">
            <div>
              <div className="label">Zcash testnet · Open source</div>
              <h1 className="display"><span className="line">Pay to unlock.</span> <span className="line"><em>Proven</em> before you pay.</span></h1>
              <p className="lede">
                Lintel sells sealed files for Zcash. Before paying, the buyer’s device checks a zero-knowledge proof
                that the ciphertext opens to exactly the content promised. The payment signature carries the key, so
                getting paid and unlocking the file are the same transaction.
              </p>
              <div className="ctas">
                <a className="btn solid" href="/app">Launch app</a>
                <Link className="btn ghost" to="/how-it-works">How it works</Link>
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
                Proving, signing and decryption run on the buyer’s and seller’s own devices. The relay passes public
                messages only. <Link to="/how-it-works">The full picture</Link>
              </p>
            </div>
            <div className="steps3">
              {STEPS.map(([h, p], i) => (
                <div key={h}><span className="num">{String(i + 1).padStart(2, '0')}</span><h3>{h}</h3><p>{p}</p></div>
              ))}
            </div>
          </div>
        </section>

        <section className="band" id="uses">
          <div className="wrap">
            <div className="band-head">
              <div>
                <div className="label">Use cases</div>
                <h2>Anything worth proving before it’s paid for.</h2>
              </div>
              <p>Reports, data, research and digital goods. <Link to="/use-cases">More use cases and size limits</Link></p>
            </div>
            <div className="uses three">
              {USES.map(([h, p], i) => (
                <div key={h}><span className="label">{String(i + 1).padStart(2, '0')}</span><h3>{h}</h3><p>{p}</p></div>
              ))}
            </div>
          </div>
        </section>

        <section className="closing">
          <div className="wrap">
            <div className="label">Try it on testnet</div>
            <h2 className="display">Pay only for what’s <em>proven</em>.</h2>
            <div className="ctas">
              <a className="btn solid" href="/app">Launch app</a>
              <Link className="btn ghost" to="/docs/quickstart">Quickstart</Link>
              <Link className="btn ghost" to="/evidence">See the evidence</Link>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
