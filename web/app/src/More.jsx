// Product pages beyond the core site: /whitepaper, /testers, /pitch, /blog,
// /blog/:slug and the legal pages (/terms, /privacy, /disclosures).
// Long-form text lives in Markdown (docs/whitepaper.md, docs/blog/*.md,
// src/content/*.md) so GitHub and the site show the same words.
import { useState } from 'react';
import { Link, SiteHeader, SiteFooter, NotFound, useTitle, GITHUB, ISSUES } from './site.jsx';
import { Prose, CopyPage, docSource } from './Docs.jsx';
import { Page, Band, Next } from './Pages.jsx';
import { RUNS, n, browserSettle } from './evidence.js';

const CONTENT = import.meta.glob('./content/*.md', { query: '?raw', import: 'default', eager: true });
const POSTS = import.meta.glob('../../../docs/blog/*.md', { query: '?raw', import: 'default', eager: true });

// ---------------------------------------------------------------- shared

function Shell({ active, children }) {
  return (
    <div className="site">
      <SiteHeader active={active} />
      <main id="content">{children}</main>
      <SiteFooter />
    </div>
  );
}

const fmtDur = (s) => `${Math.floor(s / 60)} min ${s % 60} s`;

// ---------------------------------------------------------------- /whitepaper

export function Whitepaper() {
  useTitle('Whitepaper · Lintel');
  const md = docSource('whitepaper.md');
  const [heads, setHeads] = useState([]);
  return (
    <Shell active="/docs">
      <div className="wrap paper">
        <aside className="papertoc" aria-label="Contents">
          <div className="label">Contents</div>
          <ul>{heads.map(([id, text]) => <li key={id}><a href={`#${id}`}>{text}</a></li>)}</ul>
          <div className="papertools">
            <CopyPage md={md} />
            <button type="button" className="btn ghost sm" onClick={() => print()}>Print or save as PDF</button>
            <a className="small" href={`${GITHUB}/blob/main/docs/whitepaper.md`} rel="noreferrer">Source on GitHub</a>
          </div>
        </aside>
        <Prose md={md} className="paperbody" onHeadings={setHeads} />
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------- legal pages

export function LegalPage({ name, title }) {
  useTitle(`${title} · Lintel`);
  const md = CONTENT[`./content/${name}.md`];
  if (!md) return <NotFound />;
  return (
    <Shell>
      <div className="wrap legalpage">
        <Prose md={md} />
      </div>
    </Shell>
  );
}
export const Terms = () => <LegalPage name="terms" title="Terms" />;
export const Privacy = () => <LegalPage name="privacy" title="Privacy" />;
export const Disclosures = () => <LegalPage name="disclosures" title="Risk disclosures" />;

// ---------------------------------------------------------------- /blog

/** Posts from docs/blog/*.md: title from the first heading, date line from the first italic line. */
export const posts = Object.entries(POSTS).map(([path, md]) => ({
  slug: path.split('/').pop().replace(/\.md$/, ''),
  md,
  title: (/^#\s+(.+)$/m.exec(md) || [, 'Untitled'])[1],
  meta: (/^\*([^*\n]+)\*$/m.exec(md) || [, ''])[1],
  lede: (md.split('\n\n').find((p) => p && !p.startsWith('#') && !p.startsWith('*')) || '').slice(0, 260),
}));

export function Blog() {
  useTitle('Blog · Lintel');
  return (
    <Page active="/blog" label="Blog" title={<>Notes from the <em>build</em>.</>} lede="Launches, design decisions and what broke on testnet.">
      <section className="band">
        <div className="wrap postlist">
          {posts.map((p) => (
            <article key={p.slug}>
              <span className="label">{p.meta}</span>
              <h2><Link to={`/blog/${p.slug}`}>{p.title}</Link></h2>
              <p>{p.lede}</p>
              <Link className="more" to={`/blog/${p.slug}`}>Read the post</Link>
            </article>
          ))}
        </div>
      </section>
    </Page>
  );
}

export function BlogPost({ slug }) {
  const post = posts.find((p) => p.slug === slug);
  useTitle(post ? `${post.title} · Lintel` : 'Not found · Lintel');
  if (!post) return <NotFound />;
  return (
    <Shell active="/blog">
      <div className="wrap legalpage post">
        <Link to="/blog" className="back">← Blog</Link>
        <Prose md={post.md} base="docs/blog/" />
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------- /testers

const TRY = [
  ['Seal and verify', 'About two minutes, no wallet. Seal a line of text in Sell, then paste its listing ID into Verify.', '/docs/quickstart#in-two-minutes'],
  ['A full on-chain sale', 'Two browser profiles, one seller and one buyer. Funding and settlement each wait for a testnet block.', '/docs/quickstart#full-sale-on-testnet'],
  ['The refund', 'Fund an escrow and let the seller vanish. After the lock (about 60 blocks, roughly 75 minutes) Broadcast refund should appear and work.', '/docs/quickstart#if-the-seller-disappears'],
  ['Pay from another wallet', 'Buy without the device wallet: pay the ZIP 321 request from any Zcash testnet wallet, shielded or transparent.', '/docs/onchain#pay-from-another-wallet'],
  ['Seller agent', 'Hand a listing to lintel-agent, close the seller’s browser, and buy it.', '/docs/cli#lintel-agent-seller-agent'],
  ['A big file', 'Anything over 1,953 bytes is proven in 23.8 KB parts, about 100 s each in a single-threaded tab. Check that Verify reports the right part count.', '/docs/big-payloads'],
  ['Try to cheat', 'Edit a listing’s offer JSON (a ciphertext element, a part, the hash) and paste it into Verify. It must be rejected.', '/verify'],
];

export function Testers() {
  useTitle('Become a tester · Lintel');
  return (
    <Page active="/testers" label="Testers" title={<>Break it on <em>testnet</em>.</>}
      lede="Lintel is ready for people to try, and to try to break. Everything runs on Zcash testnet with TAZ, which has no value, so nothing you do here costs real money.">
      <Band id="need" label="What you need" title="Two browsers and a few TAZ.">
        <div className="two">
          <div className="panel">
            <h3>For a sale</h3>
            <ul className="ticks plain">
              <li><b>Two browser profiles</b> (or two browsers): each side keeps its keys in its own browser storage.</li>
              <li><b>About 0.021 TAZ for a 0.02 TAZ listing.</b> Funding needs one note covering the price, 20,000 zats of settlement fees, a 20,000-zat lock coin (returned) and the 15,000-zat funding fee: 0.02055 TAZ in total.</li>
              <li><b>A faucet that pays on the NU7 testnet</b>, linked from the <Link to="/docs/quickstart">quickstart</Link>.</li>
            </ul>
          </div>
          <div className="panel">
            <h3>Optional</h3>
            <ul className="ticks plain">
              <li><b>Any Zcash testnet wallet</b>, to test paying from another wallet.</li>
              <li><b>Rust</b>, to build and run the seller agent (<code>lintel-agent</code>).</li>
              <li><b>Patience for big files.</b> Sealing 1 MB in a single-threaded tab takes over an hour.</li>
            </ul>
          </div>
        </div>
      </Band>

      <Band id="try" label="What to try" title="Seven things worth testing." intro="Each links to the steps. Note what you did, what you expected and what happened.">
        <ol className="trylist">
          {TRY.map(([h, p, to], i) => (
            <li key={h}>
              <span className="num">{String(i + 1).padStart(2, '0')}</span>
              <div><h3>{h}</h3><p>{p} <Link to={to}>How</Link></p></div>
            </li>
          ))}
        </ol>
      </Band>

      <Band id="report" label="Reporting" title="Tell us on GitHub.">
        <div className="two">
          <div className="panel">
            <h3>Bugs and rough edges</h3>
            <p className="muted">Open an issue with the bug template. Include:</p>
            <ul className="ticks plain">
              <li>what you did, what you expected and what happened;</li>
              <li>your browser and version, and any error from the browser console;</li>
              <li>the listing ID, and txids or block heights if the chain was involved.</li>
            </ul>
            <p className="spaced"><a className="btn ghost" href={`${ISSUES}/new?template=bug_report.md`} rel="noreferrer">Open a bug report</a></p>
          </div>
          <div className="panel">
            <h3>Never post</h3>
            <ul className="ticks limit">
              <li>a seller handoff file or the agent directory;</li>
              <li>a wallet or pay-in wallet backup, or anything copied from the app’s browser storage;</li>
              <li>the secret content of a listing you still want to sell.</li>
            </ul>
            <p className="muted spaced">Anything that could let someone take funds, learn a secret or break a proof is a security issue: report it privately as <a href={`${GITHUB}/blob/main/SECURITY.md`} rel="noreferrer">SECURITY.md</a> describes, not in a public issue.</p>
          </div>
        </div>
      </Band>

      <Next title={<>Start with the <em>two-minute</em> check.</>}>
        <a className="btn solid" href="/app#/sell">Seal something</a>
        <Link className="btn ghost" to="/verify">Verify a listing</Link>
      </Next>
    </Page>
  );
}

// ---------------------------------------------------------------- /pitch

export function Pitch() {
  useTitle('Pitch · Lintel');
  const txs = RUNS.reduce((a, r) => a + r.rows.length, 0);
  const heights = RUNS.flatMap((r) => r.rows.map((x) => Number(x.h)));
  return (
    <Page active="/pitch" label="Pitch" title={<>Sell what you can <em>prove</em>.</>}
      lede="Lintel turns a sale between strangers into one Zcash transaction: the buyer checks a zero-knowledge proof before paying, and the payment itself hands over the key. No escrow agent, no trusted setup, no custody.">
      <Band id="problem" label="01 · Problem" title="Someone always has to go first."
        intro="A bounty hunter wants payment before handing over the report. The project wants to read the report before paying. Data sellers and researchers have the same standoff.">
        <div className="uses three">
          <div><span className="label">Today</span><h3>Trust a middleman</h3><p>An escrow platform holds the money, reads the goods and decides disputes. It sees everything and can be breached.</p></div>
          <div><span className="label">Or</span><h3>Trust each other</h3><p>One side pays or delivers first and hopes. Fine between friends, not between strangers.</p></div>
          <div><span className="label">Earlier work</span><h3>Contingent payments</h3><p>Hash-locked Bitcoin payments with a proof showed the idea works, with the key and the lock visible on chain.</p></div>
        </div>
      </Band>

      <Band id="solution" label="02 · Solution" title="Proof, escrow and key in one construction."
        intro={<>All three are locked to the same secret. <Link to="/whitepaper">Whitepaper</Link></>}>
        <div className="steps3">
          <div><span className="num">01</span><h3>Seal and prove</h3><p>Halo 2 proofs that the ciphertext opens, under the secret behind <code>T</code>, to content with hash <code>h</code>. Up to 1,523,681 bytes, every byte proven.</p></div>
          <div><span className="num">02</span><h3>Verify, then pay</h3><p>The buyer’s device checks the proofs, then funds a shielded escrow neither side can spend alone, with a time-locked refund co-signed first.</p></div>
          <div><span className="num">03</span><h3>Settlement reveals the key</h3><p>The seller’s adaptor signature completes the payment and publishes the key in the same transaction.</p></div>
        </div>
      </Band>

      <Band id="demo" label="03 · Demo" title="Try it in two minutes." intro={<>Seal a line of text, then check its proof as a buyer would. <Link to="/docs/quickstart#in-two-minutes">Steps</Link></>}>
        <div className="shots">
          <figure><img src="/media/app-listing.png" alt="A listing in the Lintel app after the browser verified its proof" loading="lazy" /><figcaption>A listing after the buyer’s browser verified its proof.</figcaption></figure>
          <figure><img src="/media/verify.png" alt="The public Verify page showing a verified listing" loading="lazy" /><figcaption>Public verification at /verify, no wallet needed.</figcaption></figure>
        </div>
        <div className="ctas spaced">
          <a className="btn solid" href="/app">Open the app</a>
          <Link className="btn ghost" to="/verify">Verify a listing</Link>
        </div>
      </Band>

      <Band id="traction" label="04 · Traction" title="Mined on testnet, not mocked."
        intro={<>Every figure here comes from the public records in the repository. There is no real-money volume: Lintel is testnet only. <Link to="/evidence">All runs</Link></>}>
        <div className="stats">
          <div><span className="big">{txs}</span><span className="label">Testnet transactions recorded</span></div>
          <div><span className="big">{RUNS.length}</span><span className="label">Recorded runs</span></div>
          <div><span className="big">{fmtDur(browserSettle.elapsed_s)}</span><span className="label">Browser sale, end to end</span></div>
          <div><span className="big">1.5 MB</span><span className="label">Largest listing, every byte proven</span></div>
        </div>
        <p className="evnote">Blocks {n(Math.min(...heights))} to {n(Math.max(...heights))}: browser sale and refund, consensus-enforced time lock, seller agent sale with the seller’s browser closed, and two sales paid from another wallet.</p>
      </Band>

      <Band id="roadmap" label="05 · Roadmap" title="Testnet first. Mainnet only after review."
        intro={<>No dates, and no mainnet until the gates are passed. <Link to="/docs/production">Production gate</Link></>}>
        <ol className="trylist">
          <li><span className="num">Now</span><div><h3>Harden testnet</h3><p>Open testing, refund backup outside browser storage, keeping the seller’s partial signature off the public record, on-chain settlement for multi-copy listings.</p></div></li>
          <li><span className="num">Next</span><div><h3>Internal review</h3><p>Engine, circuits, relay and app, with a public remediation log.</p></div></li>
          <li><span className="num">Then</span><div><h3>External audit</h3><p>Circuits and settlement protocol, report published.</p></div></li>
          <li><span className="num">Later</span><div><h3>Production gate</h3><p>Caps, refund backup and a way to pause new listings, before any mainnet release is considered.</p></div></li>
        </ol>
      </Band>

      <Next title={<>Help us <em>break</em> it.</>}>
        <Link className="btn ghost" to="/testers">Become a tester</Link>
        <Link className="btn ghost" to="/docs/compare">How Lintel compares</Link>
      </Next>
    </Page>
  );
}
