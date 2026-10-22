// Path router and shared site chrome (landing, docs, 404).
// The marketplace keeps its own hash router under /app (#/sell, #/listing/…).
import { useEffect, useState } from 'react';

export const GITHUB = 'https://github.com/Godwin-web3/lintel';
export const APP_URL = 'https://lintel-godwin-web3s-projects.vercel.app';
/** The public relay. Its /chain/tx/:txid proxies lightwalletd, so evidence links show the mined tx and its height. */
export const PUBLIC_RELAY = 'https://lintel-relay.onrender.com';

/** Site pages outside the marketplace, in nav order. */
export const PAGES = [
  ['/how-it-works', 'How it works'],
  ['/use-cases', 'Use cases'],
  ['/evidence', 'Evidence'],
  ['/docs', 'Docs'],
];

// Sections that used to live on the landing page (/#how …) and now have their own page.
const MOVED = { how: '/how-it-works', name: '/how-it-works#name', guarantees: '/how-it-works#guarantees', stack: '/how-it-works#stack', uses: '/use-cases', evidence: '/evidence' };

/** Old links were hash routes at the site root (/#/listing/x). They now live under /app. */
export function legacyRedirect() {
  const { pathname, search, hash } = location;
  if (pathname === '/index.html') history.replaceState(null, '', '/' + search + hash);
  if ((location.pathname === '/' || location.pathname === '') && hash.startsWith('#/')) {
    history.replaceState(null, '', '/app' + search + hash);
  }
  if (location.pathname === '/' && MOVED[hash.slice(1)]) history.replaceState(null, '', MOVED[hash.slice(1)]);
}

const norm = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p) || '/';

export function usePath() {
  const [path, setPath] = useState(() => norm(location.pathname));
  useEffect(() => {
    const on = () => setPath(norm(location.pathname));
    addEventListener('popstate', on);
    addEventListener('lintel:navigate', on);
    return () => { removeEventListener('popstate', on); removeEventListener('lintel:navigate', on); };
  }, []);
  return path;
}

export function navigate(to) {
  const u = new URL(to, location.href);
  if (u.pathname + u.search + u.hash === location.pathname + location.search + location.hash) return;
  history.pushState(null, '', u.pathname + u.search + u.hash);
  dispatchEvent(new Event('lintel:navigate'));
  if (u.hash) {
    requestAnimationFrame(() => document.getElementById(decodeURIComponent(u.hash.slice(1)))?.scrollIntoView());
  } else {
    scrollTo(0, 0);
  }
}

/** Client-side link for same-origin paths outside /app. */
export function Link({ to, children, ...rest }) {
  const onClick = (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    // /app boots the prover and keeps its own hash router: give it a real page load.
    if (to.startsWith('/app')) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={onClick} {...rest}>{children}</a>;
}

export function useTitle(title) {
  useEffect(() => { document.title = title; }, [title]);
}

/** The mark, from the brand kit (brand/logo/lintel-mark-dark.svg). Never recolored. */
export function Mark({ size = 24, title }) {
  return <img className="mark" src="/brand/lintel-mark-dark.svg" width={size} height={size} alt={title || ''} aria-hidden={title ? undefined : true} />;
}

export function Lockup({ height = 32 }) {
  return <img src="/brand/lintel-lockup-dark.svg" alt="Lintel" height={height} width={Math.round((height * 339) / 110)} />;
}

export function SiteHeader({ active }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const esc = (e) => e.key === 'Escape' && close();
    addEventListener('lintel:navigate', close); addEventListener('keydown', esc);
    return () => { removeEventListener('lintel:navigate', close); removeEventListener('keydown', esc); };
  }, [open]);
  const cur = (to) => (active === to ? { className: 'on', 'aria-current': 'page' } : {});
  return (
    <header className={`sitebar${open ? ' open' : ''}`}>
      <a className="skip" href="#content">Skip to content</a>
      <div className="wrap">
        <Link to="/" className="brandlink" aria-label="Lintel home"><Lockup /></Link>
        <nav className="sitenav" aria-label="Site">
          <div className="navlinks" id="sitemenu">
            {PAGES.map(([to, label]) => <Link key={to} to={to} {...cur(to)}>{label}</Link>)}
            <a href={GITHUB} rel="noreferrer">GitHub</a>
          </div>
          <a href="/app" className="btn ghost sm">Open app</a>
          <button type="button" className="menubtn" aria-expanded={open} aria-controls="sitemenu" aria-label={open ? 'Close menu' : 'Open menu'} onClick={() => setOpen(!open)}>
            <span aria-hidden="true" />
          </button>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="sitefoot">
      <div className="wrap">
        <div>
          <Lockup height={32} />
          <p className="fine">Pay only for what’s proven. Testnet software: it runs on Zcash testnet (TAZ) and has not been audited. Do not use it with real funds.</p>
        </div>
        <div>
          <h4>Product</h4>
          <ul>
            <li><a href="/app">Marketplace</a></li>
            <li><a href="/app#/sell">Sell</a></li>
            <li><a href="/app#/wallet">Testnet wallet</a></li>
            <li><Link to="/how-it-works">How it works</Link></li>
            <li><Link to="/use-cases">Use cases</Link></li>
            <li><Link to="/evidence">Testnet evidence</Link></li>
          </ul>
        </div>
        <div>
          <h4>Docs</h4>
          <ul>
            <li><Link to="/docs/quickstart">Quickstart</Link></li>
            <li><Link to="/docs/how-it-works">Protocol</Link></li>
            <li><Link to="/docs/security-model">Security model</Link></li>
            <li><Link to="/docs/self-hosting">Self-hosting</Link></li>
            <li><Link to="/docs/cli">CLI and seller agent</Link></li>
          </ul>
        </div>
        <div>
          <h4>Project</h4>
          <ul>
            <li><a href={GITHUB} rel="noreferrer">GitHub</a></li>
            <li><a href={`${GITHUB}/blob/main/SECURITY.md`} rel="noreferrer">Report a vulnerability</a></li>
            <li><a href={`${GITHUB}/blob/main/CHANGELOG.md`} rel="noreferrer">Changelog</a></li>
          </ul>
        </div>
      </div>
    </footer>
  );
}

export function NotFound({ inApp = false }) {
  useTitle('Not found · Lintel');
  const body = (
    <div className="notfound" id="content">
      <div>
        <Mark size={72} />
        <div className="label">404 · Nothing at this address</div>
        <h1 className="display">No door here.</h1>
        <p>The page you asked for does not exist, or it moved when the marketplace went to <code>/app</code>.</p>
        <div className="ctas">
          <Link to="/" className="btn ghost">Back to the start</Link>
          <a href="/app" className="btn ghost">Open the marketplace</a>
        </div>
      </div>
    </div>
  );
  if (inApp) return body;
  return (
    <div className="site">
      <SiteHeader />
      <main className="wrap notfound-main">{body}</main>
      <SiteFooter />
    </div>
  );
}
