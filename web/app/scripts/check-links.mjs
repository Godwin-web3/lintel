// Link checker for the repo's Markdown and the site's in-app links.
// Checks: relative links in *.md point at files that exist; #anchors match a
// heading (GitHub-style ids, as Docs.jsx makes them); app links (<Link to>,
// href="/…") hit a route in Root.jsx, a docs page in Docs.jsx NAV, or /app;
// every docs/*.md is in the docs nav. Also covers blog posts (docs/blog/*.md,
// routed at /blog/:slug) and the site's own Markdown (web/app/src/content/*.md),
// whose links may be site routes ("/verify"). Run: node web/app/scripts/check-links.mjs
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const bad = [];
const slugify = (s) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
const plain = (h) => h.replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1');
function anchors(md) {
  const seen = {}, out = new Set();
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^```/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,4})\s+(.*)$/.exec(line);
    if (!m) continue;
    let id = slugify(plain(m[2]));
    if (seen[id] !== undefined) id = `${id}-${++seen[id]}`; else seen[id] = 0;
    out.add(id);
  }
  return out;
}
const mdFiles = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'brand/README.md', 'web/README.md',
  ...fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`),
  ...fs.readdirSync(path.join(ROOT, 'docs/blog')).filter((f) => f.endsWith('.md')).map((f) => `docs/blog/${f}`),
  ...fs.readdirSync(path.join(ROOT, 'web/app/src/content')).filter((f) => f.endsWith('.md')).map((f) => `web/app/src/content/${f}`)].filter((f) => fs.existsSync(path.join(ROOT, f)));
const posts = fs.readdirSync(path.join(ROOT, 'docs/blog')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
// app links
const docsJsx = rd('web/app/src/Docs.jsx');
const nav = [...docsJsx.matchAll(/\['([\w-]*)', '[^']+', '([\w-]+\.md)'\]/g)].map((m) => [m[1], m[2]]);
const slugFile = Object.fromEntries(nav);
for (const f of fs.readdirSync(path.join(ROOT, 'docs')).filter((x) => x.endsWith('.md'))) {
  if (!nav.some(([, file]) => file === f)) bad.push(`docs/${f}: not in the docs nav (Docs.jsx)`);
}
const routes = [...rd('web/app/src/Root.jsx').matchAll(/'(\/[\w-]*)': \w+/g)].map((m) => m[1]);
const siteJsx = rd('web/app/src/site.jsx');
const pagesFromSite = [...siteJsx.matchAll(/\['(\/[\w-]+)', '[^']+'\]/g)].map((m) => m[1]);
for (const p of pagesFromSite) if (p !== '/docs' && !routes.includes(p)) bad.push(`site.jsx nav: ${p} has no route`);
let count = 0;
/** Why a site path does not resolve, or '' if it does. */
function siteRoute(raw) {
  const [p, hash] = raw.split('#');
  const q = p.split('?')[0];
  if (q === '/app' || q.startsWith('/app')) return '';
  if (q.length > 1 && q.endsWith('/')) return ''; // template prefix such as `/blog/${slug}`
  if (routes.includes(q)) return '';
  if (q.startsWith('/blog/')) return posts.includes(q.slice(6)) ? '' : 'no blog post';
  if (q === '/docs' || q.startsWith('/docs/')) {
    const file = slugFile[q.slice(6)];
    if (!file) return 'no docs page';
    if (hash && !anchors(rd(`docs/${file}`)).has(hash)) return `missing anchor in ${file}`;
    return '';
  }
  if (fs.existsSync(path.join(ROOT, 'web/app/public', q))) return '';
  return 'no route';
}
for (const f of fs.readdirSync(path.join(ROOT, 'web/app/src')).filter((x) => x.endsWith('.jsx'))) {
  const src = rd(`web/app/src/${f}`);
  for (const m of src.matchAll(/(?:to|href|src)=["{]`?["']?(\/[^"'`}\s$]*)/g)) {
    count++;
    const why = siteRoute(m[1]);
    if (why) bad.push(`${f}: ${m[1]} (${why})`);
  }
}
for (const f of mdFiles) {
  const md = rd(f).replace(/```[\s\S]*?```/g, '');
  const links = [...md.matchAll(/\]\(([^)\s]+)\)/g), ...md.matchAll(/href="([^"]+)"/g), ...md.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
  for (const raw of links) {
    if (/^(https?:|mailto:)/.test(raw)) continue;
    count++;
    if (raw.startsWith('/')) { const why = siteRoute(raw); if (why) bad.push(`${f}: ${raw} (${why})`); continue; }
    const [p, hash] = raw.split('#');
    const target = p ? path.normalize(path.join(path.dirname(f), p)) : f;
    if (!fs.existsSync(path.join(ROOT, target))) { bad.push(`${f}: ${raw} (missing file)`); continue; }
    if (hash && target.endsWith('.md') && !anchors(rd(target)).has(hash)) bad.push(`${f}: ${raw} (missing anchor)`);
  }
}
console.log(`checked ${count} links in ${mdFiles.length} Markdown files and the app`);
if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
console.log('all links resolve');
