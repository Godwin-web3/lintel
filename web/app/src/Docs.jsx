// Docs (/docs/:page). Sources are the Markdown files in the repo's docs/
// folder, so GitHub renders the same pages. Links between .md files become
// in-app routes; links to other repo files go to GitHub.
import { useEffect, useMemo, useRef } from 'react';
import { marked } from 'marked';
import { Link, SiteHeader, SiteFooter, NotFound, navigate, useTitle, GITHUB } from './site.jsx';

const FILES = import.meta.glob('../../../docs/*.md', { query: '?raw', import: 'default', eager: true });
const source = (file) => FILES[`../../../docs/${file}`];

export const NAV = [
  ['Start', [['', 'Overview', 'README.md'], ['quickstart', 'Quickstart', 'quickstart.md']]],
  ['Concepts', [['how-it-works', 'How it works', 'how-it-works.md'], ['security-model', 'Security model', 'security-model.md'], ['architecture', 'Architecture', 'architecture.md']]],
  ['Run it', [['self-hosting', 'Self-hosting', 'self-hosting.md'], ['cli', 'CLI reference', 'cli.md']]],
  ['Reference', [['faq', 'FAQ', 'faq.md'], ['testnet-evidence', 'Testnet evidence', 'testnet-evidence.md'], ['onchain', 'On-chain settlement, in depth', 'onchain.md'], ['relay-perf', 'Presale, relay and proving', 'relay-perf.md'], ['big-payloads', 'Big payloads', 'big-payloads.md']]],
];
const PAGES = NAV.flatMap(([, items]) => items);
const bySlug = Object.fromEntries(PAGES.map((p) => [p[0], p]));
const byFile = Object.fromEntries(PAGES.map((p) => [p[2], p]));
const routeFor = (slug) => (slug ? `/docs/${slug}` : '/docs');

// GitHub-compatible heading ids, so #anchors work in both places.
const slugify = (s) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

/** Resolve a link found in docs/<file>.md. */
function resolve(href) {
  if (!href || /^[a-z]+:/i.test(href) || href.startsWith('//')) return { href, external: /^https?:/i.test(href) };
  if (href.startsWith('#')) return { href };
  const u = new URL(href, 'https://repo.invalid/docs/');
  const path = u.pathname.slice(1); // e.g. docs/onchain.md, web/README.md
  const file = path.startsWith('docs/') ? path.slice(5) : null;
  if (file && byFile[file]) return { href: routeFor(byFile[file][0]) + u.hash, internal: true };
  return { href: `${GITHUB}/blob/main/${path}${u.hash}`, external: true };
}

function Prose({ md }) {
  const ref = useRef(null);
  const html = useMemo(() => marked.parse(md, { gfm: true }), [md]);
  useEffect(() => {
    const el = ref.current;
    const seen = {};
    el.querySelectorAll('h1, h2, h3, h4').forEach((h) => {
      let id = slugify(h.textContent);
      if (seen[id] !== undefined) id = `${id}-${++seen[id]}`; else seen[id] = 0;
      h.id = id;
    });
    el.querySelectorAll('table').forEach((t) => {
      if (t.parentElement.classList.contains('tablewrap')) return;
      const w = document.createElement('div');
      w.className = 'tablewrap';
      t.replaceWith(w); w.appendChild(t);
    });
    el.querySelectorAll('a[href]').forEach((a) => {
      const r = resolve(a.getAttribute('href'));
      a.setAttribute('href', r.href);
      if (r.internal) a.dataset.internal = '1';
      if (r.external) a.setAttribute('rel', 'noreferrer');
    });
    if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  }, [html]);
  const onClick = (e) => {
    const a = e.target.closest('a[data-internal]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(a.getAttribute('href'));
  };
  // Content is the repository's own Markdown, bundled at build time.
  return <article className="prose" ref={ref} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

export default function Docs({ slug }) {
  const page = bySlug[slug];
  const md = page && source(page[2]);
  useTitle(page ? `${page[1]} · Lintel docs` : 'Not found · Lintel');
  if (!page || !md) return <NotFound />;
  const i = PAGES.indexOf(page);
  const prev = PAGES[i - 1], next = PAGES[i + 1];
  return (
    <div className="site">
      <SiteHeader active="docs" />
      <div className="wrap docs">
        <nav className="docnav" aria-label="Documentation">
          {NAV.map(([group, items]) => (
            <div key={group}>
              <h4>{group}</h4>
              <ul>
                {items.map(([s, label]) => (
                  <li key={s}><Link to={routeFor(s)} className={s === slug ? 'on' : ''} aria-current={s === slug ? 'page' : undefined}>{label}</Link></li>
                ))}
              </ul>
            </div>
          ))}
          <h4>Source</h4>
          <ul><li><a href={`${GITHUB}/blob/main/docs/${page[2]}`} rel="noreferrer">Edit this page on GitHub</a></li></ul>
        </nav>
        <main id="content">
          <div className="docnav-mobile">
            <label className="label" htmlFor="docpick">Docs page</label>
            <select id="docpick" value={slug} onChange={(e) => navigate(routeFor(e.target.value))}>
              {NAV.map(([group, items]) => (
                <optgroup key={group} label={group}>
                  {items.map(([s, label]) => <option key={s} value={s}>{label}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
          <Prose md={md} key={slug} />
          <nav className="docfoot prose" aria-label="Previous and next page">
            {prev ? <Link to={routeFor(prev[0])}><span className="label">Previous</span>{prev[1]}</Link> : <span />}
            {next ? <Link to={routeFor(next[0])} className="next"><span className="label">Next</span>{next[1]}</Link> : <span />}
          </nav>
        </main>
      </div>
      <SiteFooter />
    </div>
  );
}
