// Presale (v2) listings: many copies, seller-offline buying, one-step completion.
//
// Seller device storage (localStorage, never uploaded):
//   selling[listingId] = { v: 2, token, title, units: { [r_b]: { secret, used?, done? } } }
// `secret` is a unit's key share, nonce and adaptor secret. Invariant: at most
// one completion is ever persisted or released per unit. The completion is
// computed inside the worker, written to storage together with the `used`
// marker in one synchronous write, and only then sent. Retries re-send the
// stored completion; a unit marked used for one order never signs another.
//
// Buyer device storage: buying2[orderId] = { listingId, unit, token, keep, order, title }
// `keep` is the buyer's ephemeral DH secret; the signing share and nonce are
// dropped inside the worker right after pre-signing.

import { crypto, relay, store, randomHex, randomAlpha, sleep } from './api.js';

export const MAX_COPIES = 10;

// ---------- seller ----------

/** Seals `copies` units and publishes them. `onStep(i, n, ms)` reports progress. */
export async function sellV2({ payload, copies, meta, onStep = () => {} }) {
  let listing = null, token = null;
  for (let i = 0; i < copies; i++) {
    const t0 = performance.now();
    const { unit, secret, contentHash } = await crypto('sealUnit', { payload });
    // Keep the secret before publishing: a published unit without its secret
    // could take an order nobody can complete.
    const keep = (lid) => store.put((st) => {
      const e = (st.selling[lid] ||= { v: 2, token, title: meta.title, units: {} });
      e.units[unit.r_b] = { secret };
    });
    if (!listing) {
      store.put((st) => { (st.pendingUnits ||= {})[unit.r_b] = secret; });
      const r = await relay('POST', '/listings', { version: 2, ...meta, content_hash: contentHash, size: payload.length, unit });
      listing = r.listing; token = r.seller_token;
      keep(listing.id);
      store.put((st) => { delete st.pendingUnits[unit.r_b]; });
    } else {
      keep(listing.id);
      listing = (await relay('POST', `/listings/${listing.id}/units`, { unit }, token)).listing;
    }
    onStep(i + 1, copies, Math.round(performance.now() - t0), listing);
  }
  return listing;
}

/** Adds copies to an existing listing. The content must hash to the listing's hash. */
export async function addCopies({ listingId, payload, copies, onStep = () => {} }) {
  const mine = store.get().selling[listingId];
  if (!mine || mine.v !== 2) throw new Error('seller keys for this listing are not on this device');
  const { listing } = await relay('GET', `/listings/${listingId}`);
  const h = await crypto('contentHashV2', { payload });
  if (h !== listing.content_hash) throw new Error('this content does not match the listing (different hash)');
  for (let i = 0; i < copies; i++) {
    const t0 = performance.now();
    const { unit, secret } = await crypto('sealUnit', { payload });
    store.put((st) => { st.selling[listingId].units[unit.r_b] = { secret }; });
    await relay('POST', `/listings/${listingId}/units`, { unit }, mine.token);
    onStep(i + 1, copies, Math.round(performance.now() - t0));
  }
}

const withLock = (fn) => (navigator.locks ? navigator.locks.request('lintel-seller-agent', fn) : fn());

/**
 * One pass over every presale listing on this device: complete valid orders,
 * reject invalid ones. Safe to run from any page and any number of tabs.
 * Returns a per-listing summary for display.
 */
export async function sellerPass() {
  return withLock(async () => {
    const out = {};
    const ids = Object.entries(store.get().selling).filter(([, s]) => s.v === 2).map(([id]) => id);
    for (const lid of ids) {
      const sum = (out[lid] = { completed: 0, rejected: 0, waiting: 0, errors: [] });
      try {
        const [{ listing }, { orders }] = await Promise.all([relay('GET', `/listings/${lid}`), relay('GET', `/listings/${lid}/orders`)]);
        sum.listing = listing; sum.orders = orders;
        for (const o of orders) {
          if (o.status !== 'awaiting_seller') continue;
          const unitPub = listing.units[o.unit];
          const mine = store.get().selling[lid];
          const u = unitPub && mine.units[unitPub.r_b];
          if (!u) { sum.errors.push(`copy ${o.unit + 1}: keys are not on this device`); continue; }
          if (u.done) {
            if (u.used !== o.id) { sum.errors.push(`copy ${o.unit + 1}: already sold to another order; not signing again`); continue; }
            await relay('POST', `/orders/${o.id}/complete`, u.done, mine.token); // retry, identical values
            sum.completed++; continue;
          }
          const unitJson = JSON.stringify(unitPub);
          const orderJson = JSON.stringify(orderWire(o));
          if (!(await crypto('checkOrder', { unit: unitJson, order: orderJson }))) {
            await relay('POST', `/orders/${o.id}/reject`, { reason: 'invalid pre-signature or proof' }, mine.token);
            sum.rejected++; continue;
          }
          const done = await crypto('sellerComplete', { secret: u.secret, order: orderJson });
          // Persist before release (see header). Re-check under the same write.
          let ok = false;
          store.put((st) => {
            const x = st.selling[lid].units[unitPub.r_b];
            if (!x.used) { x.used = o.id; x.done = done; ok = true; }
          });
          if (!ok) { sum.errors.push(`copy ${o.unit + 1}: already used`); continue; }
          await relay('POST', `/orders/${o.id}/complete`, done, mine.token);
          sum.completed++;
        }
        sum.waiting = orders.filter((o) => o.status === 'awaiting_seller').length - sum.completed - sum.rejected;
      } catch (e) { sum.errors.push(e.message); }
    }
    return out;
  });
}

export const orderWire = (o) => ({ payer_vk: o.payer_vk, r_a: o.r_a, dh_point: o.dh_point, s_a: o.s_a, payer_pok: o.payer_pok, alpha: o.alpha, sighash: o.sighash });

/**
 * Background seller agent: runs `sellerPass` every `ms` while any page of the
 * app is open (and immediately when the tab becomes visible again).
 */
export function startSellerAgent(onResult, ms = 5000) {
  let stop = false, timer = null;
  const hasV2 = () => Object.values(store.get().selling).some((s) => s.v === 2);
  const tick = async () => {
    clearTimeout(timer);
    if (stop) return;
    if (hasV2()) { try { onResult(await sellerPass()); } catch { /* next tick */ } }
    if (!stop) timer = setTimeout(tick, ms);
  };
  const vis = () => { if (document.visibilityState === 'visible') tick(); };
  document.addEventListener('visibilitychange', vis);
  tick();
  return () => { stop = true; clearTimeout(timer); document.removeEventListener('visibilitychange', vis); };
}

// ---------- buyer ----------

/** Verifies the first open copy so the page can show the proof result. */
export async function verifyListing(listing) {
  const open = listing.units.find((u) => u.state === 'open') || listing.units[0];
  const { unit } = await relay('GET', `/listings/${listing.id}/units/${open.index}`);
  const t0 = performance.now();
  await crypto('verifyUnit', { unit: JSON.stringify(unit), contentHash: listing.content_hash });
  return { ms: Math.round(performance.now() - t0), parts: JSON.parse(unit.offer).parts.length };
}

/**
 * Orders one open copy: verifies its proof, pre-signs, publishes the order.
 * The seller does not need to be online. Returns the stored purchase.
 */
export async function orderV2(listing) {
  const candidates = listing.units.filter((u) => u.state === 'open').map((u) => u.index);
  if (!candidates.length) throw new Error('no copies left');
  for (const idx of candidates) {
    const { unit } = await relay('GET', `/listings/${listing.id}/units/${idx}`);
    if (unit.state !== 'open') continue;
    const sighash = randomHex(32), alpha = randomAlpha(); // placeholders until PCZT supplies them
    // Fresh signing share and nonce per attempt, so a refused order never reuses one.
    const { order, keep } = await crypto('buyerOrder', { unit: JSON.stringify(unit), contentHash: listing.content_hash, alpha, sighash });
    try {
      const r = await relay('POST', `/listings/${listing.id}/units/${idx}/orders`, order);
      const p = { listingId: listing.id, title: listing.title, filename: listing.filename, unit: idx, token: r.buyer_token, keep, order, id: r.order.id };
      store.put((st) => { (st.buying2 ||= {})[p.id] = p; });
      return p;
    } catch (e) {
      if (!/taken/.test(e.message)) throw e;
    }
  }
  throw new Error('every copy was taken while you were ordering; try again later');
}

export const purchases = (listingId) => Object.values(store.get().buying2 || {}).filter((p) => !listingId || p.listingId === listingId);

/** Polls until the seller completes (or rejects), then unlocks. */
export async function awaitUnlock(p, { onStatus = () => {}, signal } = {}) {
  for (;;) {
    if (signal?.aborted) throw new Error('stopped');
    const { order } = await relay('GET', `/orders/${p.id}`);
    onStatus(order.status);
    if (order.status === 'rejected') throw new Error(`seller rejected the order: ${order.reason}`);
    if (order.status === 'complete') {
      const { unit } = await relay('GET', `/listings/${p.listingId}/units/${p.unit}`);
      const bytes = await crypto('buyerUnlock', {
        keep: p.keep, unit: JSON.stringify(unit), order: JSON.stringify(p.order),
        completion: JSON.stringify({ signature: order.signature, enc_sb: order.enc_sb }),
      });
      store.put((st) => { st.buying2[p.id].unlocked = true; });
      return bytes;
    }
    await sleep(3000);
  }
}
