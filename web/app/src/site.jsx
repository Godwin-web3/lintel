// Path router and shared site chrome (landing, docs, 404).
// The marketplace keeps its own hash router under /app (#/sell, #/listing/…).
import { useEffect, useState } from 'react';

export const GITHUB = 'https://github.com/Godwin-web3/lintel';
export const APP_URL = 'https://lintel-godwin-web3s-projects.vercel.app';

/** Old links were hash routes at the site root (/#/listing/x). They now live under /app. */
export function legacyRedirect() {
  const { pathname, search, hash } = location;
  if (pathname === '/index.html') history.replaceState(null, '', '/' + search + hash);
  if ((location.pathname === '/' || location.pathname === '') && hash.startsWith('#/')) {
    history.replaceState(null, '', '/app' + search + hash);
  }
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

/** The trilithon: amber beam over two bone posts, on the 96-unit grid. */
export function Mark({ size = 24, beam = 'var(--amber)', post = 'var(--bone)', title }) {
  return (
    <svg width={size} height={size} viewBox="8 14 80 72" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <rect x="8" y="14" width="80" height="17" fill={beam} />
      <rect x="17" y="37" width="21" height="49" fill={post} />
      <rect x="58" y="37" width="21" height="49" fill={post} />
    </svg>
  );
}

export function Lockup({ height = 32 }) {
  return <img src="/brand/lintel-lockup-dark.svg" alt="Lintel" height={height} width={Math.round((height * 339) / 110)} />;
}

export function SiteHeader({ active }) {
  return (
    <header className="sitebar">
      <a className="skip" href="#content">Skip to content</a>
      <div className="wrap">
        <Link to="/" className="brandlink" aria-label="Lintel home"><Lockup /></Link>
        <nav className="sitenav" aria-label="Site">
          <Link to="/#how" className="hide-sm">How it works</Link>
          <Link to="/docs" className={active === 'docs' ? 'on' : ''} aria-current={active === 'docs' ? 'page' : undefined}>Docs</Link>
          <a href={GITHUB} className="hide-sm" rel="noreferrer">GitHub</a>
          <a href="/app" className="btn ghost sm">Open app</a>
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
          <p className="fine">Sealed until settled. Testnet software: it runs on Zcash testnet (TAZ) and has not been audited. Do not use it with real funds.</p>
        </div>
        <div>
          <h4>Product</h4>
          <ul>
            <li><a href="/app">Marketplace</a></li>
            <li><a href="/app#/sell">Sell</a></li>
            <li><a href="/app#/wallet">Testnet wallet</a></li>
          </ul>
        </div>
        <div>
          <h4>Docs</h4>
          <ul>
            <li><Link to="/docs/quickstart">Quickstart</Link></li>
            <li><Link to="/docs/how-it-works">How it works</Link></li>
            <li><Link to="/docs/security-model">Security model</Link></li>
            <li><Link to="/docs/testnet-evidence">Testnet evidence</Link></li>
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
        <Mark size={72} beam="var(--slate)" />
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
      <main style={{ padding: 0, display: 'flex' }} className="wrap">{body}</main>
      <SiteFooter />
    </div>
  );
}
