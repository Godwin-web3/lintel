# Lintel

**Thesis: selling data to a stranger means one side goes first. Lintel ties the payment to the delivery: the buyer checks a zero-knowledge proof of what the payment unlocks, and the transaction that pays the seller hands over the key.**

Tagline: pay to unlock, proven before you pay.

- Lead with sealed-data sales between two parties who don't trust each other, and with agents that buy and sell data under spending limits.
- Why the tech fits: a sale has one seller and one buyer, so nobody else holds a key. The seller proves on their device, the buyer verifies on theirs, and the escrow is a shielded Zcash note neither can spend alone.
- Not new cryptography: ZKCP, adaptor signatures, Halo 2. New, as far as we found: a ZKCP with no hash lock and no trusted setup on a shielded pool, a key that is not public after the sale (masked `s_b`), proven claims in the same proof as the decryption, and agent sales (`lintel-agent`, MCP).

## Canonical

- App and site: https://lintel-godwin-web3s-projects.vercel.app (routes `/`, `/app`, `/verify`, `/how-it-works`, `/use-cases`, `/evidence`, `/docs`, `/whitepaper`)
- Relay: https://lintel-relay.onrender.com (Render, Upstash storage; `/health` reports the storage)
- Repo: https://github.com/Godwin-web3/lintel
- Demo video: https://youtu.be/OxRVMp6467E
- Network: Zcash testnet only (NU7, Ironwood pool, v6 transactions). Amounts are TAZ.
- Testnet records: `docs/testnet/*.json`, rendered on `/evidence`

## Rules

- **Testnet only.** Never claim mainnet, a mainnet beta, an audit, "trustless", "anonymous" or "untraceable". Say "unaudited".
- **Real proofs, real transactions.** Never mock a verified proof or a mined sale. A feature is "works, mined" only with a txid in `docs/testnet/`.
- **Say what is proven.** The proof covers the content hash and the proven claims (length bounds, magic prefix, bytes at an offset). It does not judge quality.
- **Honest limits stay visible:** multi-copy presale settles off-chain; no claims-carrying sale mined yet; SDK and MCP not on npm and don't expose claims; the buyer or seller can share the key after a sale.
- **Keep code, site, README and docs in sync** in the same PR. `npm run check:links` must pass.
- **Secrets never in the repo.** Device dumps and wallet files match `*.SECRET.*` and are git-ignored. The relay never sees keys, `t` or plaintext.
- **PRs:** squash-merge as "Title (#N)" once the Vercel preview passes.
- **Brand:** tokens in `brand/tokens.css` (`npm run brand:check`); one amber primary action per screen. Plain, calm language.

## Layout

- `engine/` Rust crate `lintel` (circuits, adaptor signatures, chain, agent; bins `lintel-cli`, `lintel-chain`, `lintel-agent`)
- `wasm/` the engine for the browser
- `web/relay/` Node relay and lightwalletd proxy
- `web/app/` React + Vite site and app
- `packages/` `lintel-sdk`, `lintel-mcp`, `create-lintel-app`
- `examples/`, `docs/`, `brand/`

## Tests

- `cd engine && cargo test --release`
- `cd web/relay && npm test`
- `npm test -w lintel-sdk`, `npm test -w lintel-mcp`
- `cd web/app && npm run check:links && npm run build`
