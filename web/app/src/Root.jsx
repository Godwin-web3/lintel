// Top-level routes: landing (/), site pages (/how-it-works, /use-cases,
// /evidence), marketplace (/app, hash-routed inside), docs (/docs/:page) and
// a 404. The marketplace is loaded lazily, so the prover (WASM + parameter
// files) only boots when someone opens the app. vercel.json rewrites every
// non-asset path to index.html, so deep links load.
import { lazy, Suspense } from 'react';
import { usePath, NotFound } from './site.jsx';
import Landing from './Landing.jsx';
import Docs from './Docs.jsx';
import { HowItWorks, UseCases, Evidence } from './Pages.jsx';

const App = lazy(() => import('./App.jsx'));

const SITE = { '/': Landing, '/how-it-works': HowItWorks, '/use-cases': UseCases, '/evidence': Evidence };

export default function Root() {
  const path = usePath();
  const Page = SITE[path];
  if (Page) return <Page />;
  if (path === '/app') {
    return (
      <Suspense fallback={<div className="shell"><p className="muted bootwait">Loading the marketplace…</p></div>}>
        <App />
      </Suspense>
    );
  }
  if (path === '/docs' || path.startsWith('/docs/')) return <Docs slug={path.slice(6)} />;
  return <NotFound />;
}
