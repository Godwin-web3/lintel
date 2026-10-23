// Docs (/docs/:page). Sources are the Markdown files in the repo's docs/
// folder, so GitHub renders the same pages. Links between .md files become
// in-app routes; links to other repo files go to GitHub. The sidebar is
// grouped (Start here / Build on Lintel / How it works / Deeper), has a
// client-side search over the bundled Markdown, a "Copy page" button that
// copies the page's Markdown source, and previous/next links.
import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import { Link, SiteHeader, SiteFooter, NotFound, navigate, useTitle, GITHUB } from './site.jsx';

const FILES = import.meta.glob('../../../docs/*.md', { query: '?raw', import: 'default', eager: true });
const source = (file) => FILES[`../../../docs/${file}`];

export const NAV = [
  ['Start here', [['', 'Overview', 'README.md'], ['quickstart', 'Quickstart', 'quickstart.md'], ['what-ships-when', 'What ships when', 'what-ships-when.md'], ['faq', 'FAQ', 'faq.md']]],
  ['Build on Lintel', [['sdk', 'SDK (TypeScript)', 'sdk.md'], ['agents', 'Agents (MCP)', 'agents.md'], ['self-hosting', 'Self-hosting', 'self-hosting.md'], ['cli', 'CLI and seller agent', 'cli.md'], ['architecture', 'Architecture', 'architecture.md'], ['testnet-evidence', 'Testnet evidence', 'testnet-evidence.md']]],
  ['How it works', [['how-it-works', 'The protocol', 'how-it-works.md'], ['security-model', 'Security model', 'security-model.md'], ['threat-model', 'Threat model', 'threat-model.md'], ['compare', 'How Lintel compares', 'compare.md'], ['onchain', 'On-chain settlement, in depth', 'onchain.md'], ['big-payloads', 'Big payloads', 'big-payloads.md'], ['relay-perf', 'Presale, relay and proving', 'relay-perf.md']]],
  ['Deeper', [['production', 'Production gate', 'production.md'], ['whitepaper', 'Whitepaper', 'whitepaper.md'], ['settlement', 'Early design note', 'settlement.md']]],
];
const PAGES = NAV.flatMap(([group, items]) => items.map((p) => [...p, group]));
const bySlug = Object.fromEntries(PAGES.map((p) => [p[0], p]));
const byFile = Object.fromEntries(PAGES.map((p) => [p[2], p]));
// The whitepaper is a docs page with its own top-level route and layout.
export const routeFor = (slug) => (slug === 'whitepaper' ? '/whitepaper' : slug ? `/docs/${slug}` : '/docs');
export const docSource = source;

// GitHub-compatible heading ids, so #anchors work in both places.
const slugify = (s) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

/** Resolve a link found in a Markdown file under `base` (a repo directory such as `docs/`). */
function resolve(href, base) {
  if (!href || /^[a-z]+:/i.test(href) || href.startsWith('//')) return { href, external: /^https?:/i.test(href) };
  if (href.startsWith('#')) return { href };
  if (href.startsWith('/')) return { href, internal: !href.startsWith('/app') }; // site route (app-only content)
  const u = new URL(href, `https://repo.invalid/${base}`);
  const path = u.pathname.slice(1); // e.g. docs/onchain.md, web/README.md
  const file = path.startsWith('docs/') ? path.slice(5) : null;
  if (file && byFile[file]) return { href: routeFor(byFile[file][0]) + u.hash, internal: true };
  const post = /^docs\/blog\/([\w-]+)\.md$/.exec(path);
  if (post) return { href: `/blog/${post[1]}${u.hash}`, internal: true };
  return { href: `${GITHUB}/blob/main/${path}${u.hash}`, external: true };
}

/** Renders repository Markdown (bundled at build time) with GitHub-style heading ids. */
export function Prose({ md, base = 'docs/', className = '', onHeadings }) {
  const ref = useRef(null);
  const html = useMemo(() => marked.parse(md, { gfm: true }), [md]);
  useEffect(() => {
    const el = ref.current;
    const seen = {};
    const heads = [];
    el.querySelectorAll('h1, h2, h3, h4').forEach((h) => {
      let id = slugify(h.textContent);
      if (seen[id] !== undefined) id = `${id}-${++seen[id]}`; else seen[id] = 0;
      h.id = id;
      if (h.tagName === 'H2') heads.push([id, h.textContent]);
    });
    onHeadings?.(heads);
    el.querySelectorAll('table').forEach((t) => {
      if (t.parentElement.classList.contains('tablewrap')) return;
      const w = document.createElement('div');
      w.className = 'tablewrap';
      t.replaceWith(w); w.appendChild(t);
    });
    el.querySelectorAll('a[href]').forEach((a) => {
      const r = resolve(a.getAttribute('href'), base);
      a.setAttribute('href', r.href);
      if (r.internal) a.dataset.internal = '1';
      if (r.external) a.setAttribute('rel', 'noreferrer');
    });
    if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  }, [html]); // eslint-disable-line react-hooks/exhaustive-deps
  const onClick = (e) => {
    const a = e.target.closest('a[data-internal]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(a.getAttribute('href'));
  };
  // Content is the repository's own Markdown, bundled at build time.
  return <article className={`prose ${className}`} ref={ref} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** "Copy page": puts the page's Markdown source on the clipboard. */
export function CopyPage({ md }) {
  const [done, setDone] = useState('');
  const copy = async () => {
    try { await navigator.clipboard.writeText(md); setDone('Copied'); } catch { setDone('Copy failed'); }
    setTimeout(() => setDone(''), 1800);
  };
  return <button type="button" className="btn ghost sm" onClick={copy} aria-live="polite">{done || 'Copy page'}</button>;
}

// ---- search: plain substring match over the bundled Markdown, no index to ship ----
const plainText = (md) => md.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/[#>*_|]/g, ' ').replace(/-{3,}/g, ' ').replace(/\s+/g, ' ').trim();
let INDEX = null;
const index = () => (INDEX ??= PAGES.map(([slug, label, file, group]) => ({ slug, label, group, text: plainText(source(file) || '') })));

function search(q) {
  const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return [];
  const out = [];
  for (const p of index()) {
    const hay = p.text.toLowerCase(), lab = p.label.toLowerCase();
    if (!terms.every((t) => hay.includes(t) || lab.includes(t))) continue;
    const score = terms.reduce((a, t) => a + (lab.includes(t) ? 50 : 0) + Math.min(20, hay.split(t).length - 1), 0);
    const at = Math.max(0, hay.indexOf(terms[0]));
    const from = Math.max(0, at - 60);
    const snippet = (from ? '…' : '') + p.text.slice(from, at + 110).trim() + '…';
    out.push({ ...p, score, snippet });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8);
}

function DocSearch({ id }) {
  const [q, setQ] = useState('');
  const hits = useMemo(() => search(q), [q]);
  useEffect(() => {
    const clear = () => setQ('');
    addEventListener('lintel:navigate', clear);
    return () => removeEventListener('lintel:navigate', clear);
  }, []);
  return (
    <div className="docsearch" role="search">
      <label className="label" htmlFor={id}>Search the docs</label>
      <input id={id} type="search" value={q} placeholder="refund, blobs, ZIP 321…" onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      {q.trim().length > 1 && (
        <ul className="hits" aria-live="polite">
          {hits.length === 0 && <li className="muted small">No page mentions that.</li>}
          {hits.map((h) => (
            <li key={h.slug}>
              <Link to={routeFor(h.slug)}><b>{h.label}</b><span className="label">{h.group}</span><small>{h.snippet}</small></Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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
      <SiteHeader active="/docs" />
      <div className="wrap docs">
        <nav className="docnav" aria-label="Documentation">
          <DocSearch id="docsearch" />
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
            <DocSearch id="docsearch-m" />
            <label className="label" htmlFor="docpick">Docs page</label>
            <select id="docpick" value={slug} onChange={(e) => navigate(routeFor(e.target.value))}>
              {NAV.map(([group, items]) => (
                <optgroup key={group} label={group}>
                  {items.map(([s, label]) => <option key={s} value={s}>{label}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="doctools">
            <span className="label">{page[3]}</span>
            <CopyPage md={md} />
          </div>
          <Prose md={md} key={slug} />
          <nav className="docfoot prose" aria-label="Previous and next page">
            {prev ? <Link to={routeFor(prev[0])}><span className="label">Previous · {prev[3]}</span>{prev[1]}</Link> : <span />}
            {next ? <Link to={routeFor(next[0])} className="next"><span className="label">Next · {next[3]}</span>{next[1]}</Link> : <span />}
          </nav>
        </main>
      </div>
      <SiteFooter />
    </div>
  );
}
