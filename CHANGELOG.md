# Changelog

All notable changes to Lintel. Dates are 2026.

## Unreleased

- Bigger proven payloads (offer v3): listings hold up to 1,523,681 bytes (about 1.5 MB, was 7,905), on-chain or multi-copy, and every byte's decryption is still proven. Larger files are proven in 23,808-byte parts at k = 15 (second pinned parameter file `params-big.bin`, 2 MB, transparent), with a rate-2 Poseidon keystream (a third fewer rows per byte; soundness argument in `docs/big-payloads.md`). Each part's ciphertext and proof is a SHA-256-named blob on the relay (`PUT/GET /blobs/:sha256`, checked by the relay, the app and the engine); listings keep a small manifest, which removes the relay's four-part cap. Parts can be proven in parallel natively. Measured on 2 vCPU: 13.3 s and 1 GB per 23.8 KB part natively (0.56 ms/byte, 3x cheaper than before), about 100 s per part in single-threaded WASM.
- Pay from another wallet: buyers fund an on-chain purchase from any Zcash testnet wallet via a ZIP 321 request (QR) to a per-purchase pay-in wallet; shielded (Ironwood) and transparent payments both work, the escrow is funded straight from the payment, and leftovers can be withdrawn. Live testnet sales paid through each receiver (fundings 4,529,996 and 4,530,012).
- Seller agent (`lintel-agent`): finishes on-chain sales while the seller's browser is closed. Live testnet sale settled by the agent alone (funding 4,529,902, settlement 4,529,908).
- Brand identity v1.0: trilithon mark, palette, Instrument Serif / Geist / Geist Mono, self-hosted fonts, brand kit in `brand/`.
- Landing page at `/`, marketplace moved to `/app` (old links redirect), docs at `/docs`, 404 page, social cards and app icons.
- Full documentation: quickstart, how it works, security model, architecture, self-hosting, CLI, FAQ, testnet evidence.
- Project files: dual MIT/Apache-2.0 license, security policy, contributing guide, code of conduct, issue and PR templates.

## Oct 20 — Browser on-chain settlement (#8)

- Single-copy listings settle on Zcash testnet from the browser: joint escrow, buyer funding, time-locked refund co-signed before funding, seller settlement, buyer unlock from the mined signature.
- Built-in minimal testnet wallet; relay chain proxy (`/chain/*`).
- Live browser sale mined (funding 4,522,583, settlement 4,522,588).

## Oct 20 — Relay persistence, presale, multi-proof, threads (#7)

- Upstash Redis storage for the relay.
- Multi-copy presale listings that sell while the seller is offline.
- Multi-proof payloads up to 7,905 bytes; optional multithreaded proving (`LINTEL_THREADS=1`).
- Presale unlock bound to the verified copy digest; identity points rejected.

## Oct 20 — On-chain testnet settlement (#5)

- Escrow on NU7 testnet (Ironwood pool, v6), real shielded sighash, signature extraction from mined transactions.
- v2 refund: escrow note plus a transparent lock coin with `nLockTime`, so consensus rejects refunds before the seller's claim window closes.
- `lintel-chain` CLI.

## Oct 20 — Vercel build fix (#4)

- Create `public/` before writing `params.bin`.

## Oct 20 — Browser app (#3)

- Engine compiled to WebAssembly; proving in a Web Worker.
- Public-data relay (Render blueprint) and React + Vite app for selling, buying and unlocking.
- Pinned proving parameters.

## Oct 19 — Sealed goods (#2)

- Verifiable encryption under the adaptor secret: pay to decrypt, with a Halo 2 proof that the ciphertext opens to content with the agreed hash.
- `lintel-cli sealed-demo`.

## Oct 19 — Build and soundness fixes (#1)

- Build fixed on current halo2 and pasta releases; min-value disclosure soundness fixes.
