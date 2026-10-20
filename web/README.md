# Lintel web app

A marketplace for **pay-to-decrypt sealed goods**. Sellers seal a secret (a bug
report, a key, a small file) in their browser; buyers verify a Halo 2 proof that
the ciphertext decrypts to content with the committed hash, then buy. The
completed payment signature reveals the unlock secret `t` to the buyer.

```
web/app    React + Vite frontend (deploy to Vercel). All crypto in a Web Worker via lintel-wasm.
web/relay  Zero-dependency Node relay (deploy to Render). Public data only.
web/e2e.mjs  Seller and buyer trade through a live relay; checks the relay never sees plaintext or t.
```

## What stays where

| Data | Where it lives |
| --- | --- |
| Seller signing share, adaptor secret `t` (one per copy on presale listings) | Seller's browser (worker memory + localStorage) |
| Buyer signing share, nonce | Buyer's worker memory, for one purchase (dropped right after pre-signing on presale listings) |
| Buyer's ephemeral DH key (presale) | Buyer's localStorage, to unmask `s_b` and resume after a reload |
| Plaintext | Seller's device before sealing, buyer's device after unlock |
| Listing, ciphertext, Halo 2 proof, `T`, content hash, keys' public halves, partial/pre/final signatures | Relay |

Every value from the relay is re-verified in the browser (offer proof, `T`
binding, proof of knowledge, pre-signature, final signature), so a malicious
relay can stall a sale but cannot forge one or learn the content.

The proving parameters (`params.bin`, 512 KB, transparent setup) are downloaded
instead of regenerated, which cuts setup from ~50 s to ~11 s in the browser.
Their BLAKE2b digest is pinned in the WASM; a substituted file is rejected,
since swapped generators would break soundness.

## Presale listings (default for new listings)

New listings use the presale protocol (see [docs/relay-perf.md](../docs/relay-perf.md)):
several copies, each with its own unlock secret; buyers pre-sign without the
seller online; the seller's browser completes pending sales the next time the
app is open on that device, on any page. Payloads up to 7,905 bytes (proved in
up to 4 parts with the same pinned parameters). Single-copy v1 listings still
work through the old routes.

## Run locally

```bash
# relay
cd web/relay && npm start                     # :8787
# app (needs Rust + wasm-pack)
cd web/app && npm install && npm run wasm && npm run dev
# end-to-end check (v1 + presale, through a live relay)
node web/e2e.mjs
# relay tests (v1, presale, storage backends incl. a mock Upstash)
cd web/relay && npm test
# optional threaded engine (nightly Rust), then headless-Chromium UI test and benchmark.
# The scripts start their own relay on RELAY_URL (default http://localhost:8787), and the
# app only talks to the relay baked in at build time, so build with the same URL.
cd web/app && npm run wasm:mt && VITE_RELAY_URL=http://localhost:8787 npm run build
PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core/index.js node scripts/ui-test.mjs
PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core/index.js node scripts/bench.mjs
```

## Deploy

- **Relay → Render**: `render.yaml` at the repo root. Set `ALLOWED_ORIGINS` to the Vercel URL. For storage that survives redeploys on the free plan, set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` from a free Upstash Redis database (steps in [docs/relay-perf.md](../docs/relay-perf.md#a-persistent-relay-storage-free-hosting)). `RELAY_STORAGE=file|memory|upstash` overrides the choice.
- **App → Vercel**: root directory `web/app`; `vercel.json` runs `build.sh`, which installs Rust and wasm-pack, builds the WASM and parameters, the optional threaded engine (nightly; skipped on failure or with `LINTEL_THREADS=0`), then the app. `vercel.json` sends COOP/COEP so the threaded engine can use `SharedArrayBuffer`. Set `VITE_RELAY_URL` to the Render URL.

## Current limits (be honest in demos)

- **No on-chain settlement yet.** The completed signature travels through the relay rather than inside a broadcast Orchard transaction, and `sighash`/`alpha` are random placeholders. Next step: WebZjs (lightwalletd via gRPC-web) + PCZT, with the joint key bound to the note's `ak`.
- **Copies are pre-sealed.** Each copy costs the seller one proof per part at listing time (threaded proving helps; see the PR for timings). v1 listings still sell once.
- **Up to 7,905 bytes** of content per presale listing (1,953 on v1).
- **The seller must come back once.** Buyers never wait for the seller to start, but a sale only completes when the seller's app next runs: completing reveals `t`, and no third party is given `t`.
- No refund/timeout path yet.
