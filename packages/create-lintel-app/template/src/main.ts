// Lintel starter: browse listings, verify a listing's Halo 2 proof in this
// browser, then buy it on Zcash testnet. Funding: pay a ZIP 321 request from
// any testnet wallet (default) or use an in-browser wallet. The decryption
// key is read from the mined settlement transaction and checked here.
//
// Keys live in this browser's localStorage (key "lintel-starter.v1"). Testnet only.
import './style.css';
import { createLintel, LocalStorageStore, fmtZec, walletNeedFor, zats, type AnyListing, type BuyStep } from 'lintel-sdk';

const RELAY = import.meta.env.VITE_LINTEL_RELAY || 'https://lintel-relay.onrender.com';
const lintel = await createLintel({ relayUrl: RELAY, store: new LocalStorageStore('lintel-starter.v1') });
const app = document.querySelector<HTMLElement>('#app')!;

const h = (tag: string, attrs: Record<string, any> = {}, ...kids: Array<Node | string | null | false>) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const k of kids) if (k) el.append(k);
  return el;
};
const short = (s: string, n = 12) => (s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-6)}` : s);

async function home() {
  app.replaceChildren(h('h1', {}, 'Lintel starter'), h('p', { class: 'muted' }, `Relay ${RELAY} · Zcash testnet`), h('p', {}, 'Loading listings…'));
  const listings = (await lintel.listings()).filter((l) => l.status === 'open' && (l as any).version !== 2);
  const list = h('ul', { class: 'list' });
  for (const l of listings) list.append(h('li', {}, h('button', { onclick: () => open(l) }, h('b', {}, l.title), h('span', {}, `${l.price_zec} TAZ · ${l.size} bytes`))));
  app.replaceChildren(
    h('h1', {}, 'Lintel starter'),
    h('p', { class: 'muted' }, `Relay ${RELAY} · Zcash testnet · pay only for what's proven`),
    listings.length ? list : h('p', {}, 'No open single-copy listings on this relay yet. List one with the seller example (examples/seller.mjs) or the Lintel app.'),
  );
}

async function open(l: AnyListing) {
  const log = h('ol', { class: 'log' });
  const say = (s: string) => log.append(h('li', {}, s));
  const actions = h('div', { class: 'actions' });
  app.replaceChildren(
    h('button', { class: 'link', onclick: home }, '← All listings'),
    h('h1', {}, l.title),
    h('p', {}, l.description || ''),
    h('dl', {}, h('dt', {}, 'Price'), h('dd', {}, `${l.price_zec} TAZ`), h('dt', {}, 'Size'), h('dd', {}, `${l.size} bytes`), h('dt', {}, 'Content hash'), h('dd', { class: 'mono' }, short(l.content_hash))),
    actions, log,
  );
  say('Verifying the Halo 2 proof in this browser…');
  try {
    const v = await lintel.verify(l.id);
    say(`Proof verified in ${(v.ms / 1000).toFixed(1)} s (${v.kind}${v.kind === 'big' ? `, ${v.parts} parts` : ''}). The ciphertext opens, under the key this purchase reveals, to content with the listed hash.`);
  } catch (e: any) {
    say(`Proof does NOT verify: ${e.message}. Do not buy.`);
    return;
  }
  const price = zats(l.price_zec);
  actions.append(
    h('button', { onclick: () => buy(l, 'payin', log) }, `Buy: pay from any testnet wallet`),
    h('button', { class: 'secondary', onclick: () => walletPanel(l, log) }, `Buy with an in-browser wallet (needs one note ≥ ${fmtZec(walletNeedFor(price))} TAZ)`),
  );
}

async function walletPanel(l: AnyListing, log: HTMLElement) {
  const info = await lintel.wallet.info();
  const out = h('div', { class: 'card' });
  const txid = h('input', { placeholder: 'txid of a faucet payment to this address', class: 'mono' }) as HTMLInputElement;
  const refresh = () => walletPanel(l, log);
  if (!info) {
    out.append(h('p', {}, 'No in-browser wallet yet.'), h('button', { onclick: async () => { await lintel.wallet.create(); refresh(); } }, 'Create testnet wallet'));
  } else {
    out.append(
      h('p', {}, 'Address: ', h('span', { class: 'mono' }, info.address)),
      h('p', {}, `Spendable: ${fmtZec(info.balance)} TAZ`),
      txid, h('button', { onclick: async () => { try { await lintel.wallet.scan(txid.value.trim()); } catch (e: any) { alert(e.message); } refresh(); } }, 'Scan'),
      h('button', { onclick: () => buy(l, 'wallet', log) }, 'Buy with this wallet'),
    );
  }
  document.querySelector('.card')?.remove();
  log.before(out);
}

async function buy(l: AnyListing, funding: 'payin' | 'wallet', log: HTMLElement) {
  document.querySelectorAll<HTMLButtonElement>('.actions button, .card button').forEach((b) => (b.disabled = true));
  const say = (s: string) => log.append(h('li', {}, s));
  const purchase = lintel.buy(l.id, { funding });
  let shownPay = false, last = '';
  try {
    for await (const s of purchase.watch({ intervalMs: 8000 })) {
      if (s.payment && !shownPay) { shownPay = true; showPayment(s, log); }
      if (s.note !== last) { say(`[${s.phase}] ${s.note}`); last = s.note; }
      if (s.done) { showResult(l, s); return; }
    }
  } catch (e: any) {
    say(`Stopped: ${e.message}`);
    const r = await purchase.refundStatus().catch(() => null);
    if (r) say(`Your co-signed refund is stored in this browser; it becomes valid at block ${r.lockHeight} (now ${r.tip}).`);
  }
}

function showPayment(s: BuyStep, log: HTMLElement) {
  const p = s.payment!;
  log.before(h('div', { class: 'card' },
    h('p', {}, h('b', {}, `Pay exactly ${fmtZec(p.amount)} TAZ`), ' from any Zcash testnet wallet. This page watches the chain and continues once the payment is mined.'),
    h('p', {}, h('a', { href: p.uri }, 'Open in wallet (ZIP 321)'), ' · ', h('a', { href: p.uriTransparent }, 'transparent-only wallets')),
    h('p', { class: 'mono small' }, p.uri),
    h('button', { class: 'secondary', onclick: () => navigator.clipboard.writeText(p.uri) }, 'Copy payment request'),
  ));
}

function showResult(l: AnyListing, s: BuyStep) {
  const bytes = s.plaintext!;
  let text: string | null = null;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* binary */ }
  const blob = new Blob([bytes as BlobPart]);
  app.append(h('div', { class: 'card done' },
    h('h2', {}, 'Unlocked'),
    s.txids.settlement ? h('p', { class: 'small' }, 'Settlement ', h('a', { href: `${RELAY}/chain/tx/${s.txids.settlement}`, class: 'mono' }, short(s.txids.settlement))) : null,
    text !== null ? h('pre', {}, text) : h('p', {}, `${bytes.length} bytes`),
    h('a', { href: URL.createObjectURL(blob), download: (l as any).filename || `${l.id}.bin` }, 'Download'),
  ));
}

home().catch((e) => app.replaceChildren(h('p', {}, `Could not reach the relay: ${e.message}`)));
