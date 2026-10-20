// Top-level routes: landing (/), marketplace (/app, hash-routed inside),
// docs (/docs/:page) and a 404. The marketplace is loaded lazily, so the
// prover (WASM + 512 KB parameters) only boots when someone opens the app.
import { lazy, Suspense } from 'react';
import { usePath, NotFound } from './site.jsx';
import Landing from './Landing.jsx';
import Docs from './Docs.jsx';

const App = lazy(() => import('./App.jsx'));

export default function Root() {
  const path = usePath();
  if (path === '/') return <Landing />;
  if (path === '/app') {
    return (
      <Suspense fallback={<div className="shell"><p className="muted" style={{ padding: '96px 0' }}>Loading the marketplace…</p></div>}>
        <App />
      </Suspense>
    );
  }
  if (path === '/docs' || path.startsWith('/docs/')) return <Docs slug={path.slice(6)} />;
  return <NotFound />;
}
