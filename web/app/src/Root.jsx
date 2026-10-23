// Top-level routes: landing (/), site pages (/how-it-works, /use-cases,
// /evidence, /testers, /pitch, /blog, legal pages), the whitepaper, the public
// verifier (/verify), marketplace (/app, hash-routed inside), docs
// (/docs/:page), blog posts (/blog/:slug) and a 404. The marketplace and the
// verifier are loaded lazily, so the prover (WASM + parameter files) only
// boots when someone opens one of them. vercel.json rewrites every non-asset
// path to index.html, so deep links load.
import { lazy, Suspense } from 'react';
import { usePath, NotFound } from './site.jsx';
import Landing from './Landing.jsx';
import Docs from './Docs.jsx';
import { HowItWorks, UseCases, Evidence } from './Pages.jsx';
import { Whitepaper, Testers, Pitch, Blog, BlogPost, Terms, Privacy, Disclosures } from './More.jsx';

const App = lazy(() => import('./App.jsx'));
const Verify = lazy(() => import('./Verify.jsx'));

// One entry per line, `'/path': Component` (scripts/check-links.mjs reads this map).
const SITE = {
  '/': Landing,
  '/how-it-works': HowItWorks,
  '/use-cases': UseCases,
  '/evidence': Evidence,
  '/whitepaper': Whitepaper,
  '/testers': Testers,
  '/pitch': Pitch,
  '/blog': Blog,
  '/terms': Terms,
  '/privacy': Privacy,
  '/disclosures': Disclosures,
  '/verify': Verify,
};
const LAZY = new Set([Verify]);

const wait = (msg) => <div className="shell"><p className="muted bootwait">{msg}</p></div>;

export default function Root() {
  const path = usePath();
  const Page = SITE[path];
  if (Page && LAZY.has(Page)) return <Suspense fallback={wait('Loading the verifier…')}><Page /></Suspense>;
  if (Page) return <Page />;
  if (path === '/app') return <Suspense fallback={wait('Loading the marketplace…')}><App /></Suspense>;
  if (path === '/docs/whitepaper') return <Whitepaper />;
  if (path === '/docs' || path.startsWith('/docs/')) return <Docs slug={path.slice(6)} />;
  if (path.startsWith('/blog/')) return <BlogPost slug={path.slice(6)} />;
  return <NotFound />;
}
