# Changelog

All notable changes to Lintel. Dates are 2026.

## Unreleased

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
