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
| Seller signing share, adaptor secret `t` | Seller's browser (worker memory + localStorage) |
| Buyer signing share, nonce | Buyer's worker memory, for one purchase |
| Plaintext | Seller's device before sealing, buyer's device after unlock |
| Listing, ciphertext, Halo 2 proof, `T`, content hash, keys' public halves, partial/pre/final signatures | Relay |

Every value from the relay is re-verified in the browser (offer proof, `T`
binding, proof of knowledge, pre-signature, final signature), so a malicious
relay can stall a sale but cannot forge one or learn the content.

The proving parameters (`params.bin`, 512 KB, transparent setup) are downloaded
instead of regenerated, which cuts setup from ~50 s to ~11 s in the browser.
Their BLAKE2b digest is pinned in the WASM; a substituted file is rejected,
since swapped generators would break soundness.

## Run locally

```bash
# relay
cd web/relay && npm start                     # :8787
# app (needs Rust + wasm-pack)
cd web/app && npm install && npm run wasm && npm run dev
# end-to-end check
node web/e2e.mjs
```

## Deploy

- **Relay → Render**: `render.yaml` at the repo root. Set `ALLOWED_ORIGINS` to the Vercel URL.
- **App → Vercel**: root directory `web/app`; `vercel.json` runs `build.sh`, which installs Rust and wasm-pack, builds the WASM and parameters, then the app. Set `VITE_RELAY_URL` to the Render URL.

## Current limits (be honest in demos)

- **The pages run the off-chain demo flow.** In the pages, the completed signature still travels through the relay and `sighash`/`alpha` are placeholders.
  On-chain settlement works on testnet through `lintel-chain` (see [docs/onchain.md](../docs/onchain.md)).
  The worker already exposes `merchantBindJoint`, `payerBindJoint`, `verifyPayerKnowledge`, `refundPartial`, `refundSign` and `unlockFromTx`.
  The relay stores write-once public settlement fields (`POST /sessions/:id/chain/:field`) and proxies mined transactions from lightwalletd (`GET /chain/tx/:txid`), so `t` can be taken from the chain instead of the relay.
- **One sale per listing.** `t` becomes public after the first completed signature.
- **Up to 1,953 bytes** of content per listing. Sealing takes ~30 s in a browser (single-threaded); verifying ~0.5 s.
- **Seller must be online** (My sales page open) while a buyer purchases.
- Refund: implemented on chain (pre-signed before funding, v6 deferred anchors), not yet in the pages.
