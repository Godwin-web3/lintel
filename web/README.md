# Lintel web app

A marketplace for **pay-to-decrypt sealed goods**: pay only for what's proven. Sellers seal a secret (a bug
report, a key, a file up to about 1.5 MB) in their browser; buyers verify a Halo 2 proof that
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

The proving parameters (`params.bin`, 512 KB, and `params-big.bin`, 2 MB, for
big offers; transparent setup) are downloaded instead of regenerated, which cuts
setup from ~50 s to ~11 s in the browser. Their BLAKE2b digests are pinned in the
WASM; a substituted file is rejected, since swapped generators would break
soundness.

## Listings

- **Single copy, on Zcash testnet (v1 listings).** Escrow, time-locked refund and
  settlement are built, proven and checked in the browser; the buyer reads `t`
  from the mined settlement. Buyers fund from the in-browser wallet or pay a
  ZIP 321 request from any testnet wallet ("Pay from another wallet"). Sellers
  keep My sales open or hand the listing to the seller agent (`lintel-agent`).
  See [docs/onchain.md](../docs/onchain.md).
- **Multi-copy presale (v2 listings).** Several copies, each with its own unlock
  secret; buyers pre-sign without the seller online; the seller's browser
  completes pending sales the next time the app is open on that device, on any
  page. Settled off-chain. See [docs/relay-perf.md](../docs/relay-perf.md).

Payloads up to 1,523,681 bytes with every byte's decryption proven: one proof up
to 1,953 bytes, up to four proofs up to 7,905 bytes (presale), then offer v3 in
23,808-byte parts at k = 15 (`params-big.bin`, 2 MB, fetched on first use), each
part's ciphertext and proof a SHA-256-named relay blob
([docs/big-payloads.md](../docs/big-payloads.md)).

## Site routes

`/` landing, `/how-it-works`, `/use-cases`, `/evidence` (txids from
`docs/testnet/*.json`, imported at build time), `/docs/:page` (rendered from
`docs/*.md`), `/app` the marketplace (hash-routed: `#/sell`, `#/mine`,
`#/wallet`, `#/listing/:id`). `vercel.json` rewrites non-asset paths to
`index.html`, so deep links load.

## Run locally

```bash
# relay
cd web/relay && npm start                     # :8787 (PORT to change)
# app (needs Rust + wasm-pack)
cd web/app && npm install && npm run wasm && npm run wasm:chain && npm run dev
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
- **App → Vercel**: root directory `web/app`; `vercel.json` runs `build.sh`, which installs Rust and wasm-pack, builds the WASM and parameters, then the app. The threaded engine is opt-in (`LINTEL_THREADS=1`, nightly; skipped on failure) because it has not been verified in the Vercel build image yet. `vercel.json` sends COOP/COEP so the threaded engine can use `SharedArrayBuffer`. Set `VITE_RELAY_URL` to the Render URL.

## Current limits (be honest in demos)

- **Testnet only, unaudited.**
- **Someone must act for the seller of an on-chain listing**: the open app or a
  running `lintel-agent` co-signs the refund before funding and broadcasts the
  settlement before it expires. There is no hosted agent.
- **Multi-copy listings settle off-chain**: the completed signature travels
  through the relay and no coins move.
- **Copies are pre-sealed.** Each copy costs the seller one proof per part at
  listing time. v1 listings sell once (`t` becomes public after the sale).
- **Big files are slow to seal in a browser**: about 100 s per 23.8 KB part
  single-threaded (over an hour for 1 MB); small files 15 to 30 s; verifying is
  about 0.5 s per small proof and 1.5 s per big part.
- **Minimal wallet.** The device wallet knows only notes scanned in by txid; the
  signed refund lives only in that browser's localStorage.
