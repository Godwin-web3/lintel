# What ships when

What works on Zcash testnet today, what does not exist yet, and what has to happen before Lintel is anything more than testnet software. Every "works" line is backed by code in this repository and, where it touches the chain, by a mined transaction in [Testnet evidence](testnet-evidence.md).

> **Testnet only.** Lintel runs on Zcash testnet with TAZ, which has no value. It has not been audited. Mainnet is not planned until testnet is solid and the code has been reviewed; the conditions are on the [Production gate](production.md) page.

## Works today (testnet)

| Feature | Status | Where it is shown |
| --- | --- | --- |
| Seal a file and prove it in the browser (Halo 2, no trusted setup) | Works | [How it works](how-it-works.md#2-sealed-goods-verifiable-encryption-under-t) |
| Payloads up to 1,523,681 bytes, every byte's decryption proven (offer v3, up to 64 parts at k = 15) | Works | [Big payloads](big-payloads.md) |
| Proven claims: length bounds, magic prefix and bytes at an offset, proven in the same proof as the decryption; the Sell form adds them, the relay shape-checks them, the buyer's browser verifies them and shows them in plain English | Works in the browser; no sale carrying claims has been mined yet | [Proven claims](predicates.md) |
| Verify a listing's proof in the browser before paying, including a public check with no wallet at `/verify` | Works | [Quickstart](quickstart.md#in-two-minutes) |
| Single-copy on-chain sale: joint escrow, adaptor-signed settlement, key read from the mined transaction | Works, mined | [Evidence: browser sale](testnet-evidence.md#browser-sale-app-ui-two-browser-contexts) |
| Time-locked refund (v2), co-signed before funding, rejected by consensus before its lock height | Works, mined | [Evidence: v2 time lock](testnet-evidence.md#v2-time-locked-refund-cli) |
| Pay from another wallet (ZIP 321 request, shielded or transparent receiver) | Works, mined | [Evidence: pay from another wallet](testnet-evidence.md#pay-from-another-wallet-buyer-without-a-device-wallet) |
| Seller agent `lintel-agent`: finishes on-chain sales with the seller's browser closed | Works, mined | [Evidence: seller agent](testnet-evidence.md#seller-agent-sale-sellers-browser-closed) |
| Multi-copy (presale) listings, up to 10 copies from the Sell form, buyers order while the seller is offline | Works, off-chain only | [How it works](how-it-works.md#6-multi-copy-presale-listings) |
| Optional multithreaded browser prover (`LINTEL_THREADS=1` build) | Opt-in, measured for small offers | [Presale, relay and proving](relay-perf.md#d-multithreaded-browser-proving) |
| Self-hosted relay (Render + Upstash) and app (Vercel) | Works | [Self-hosting](self-hosting.md) |
| TypeScript SDK (`lintel-sdk`, Node and browser), `create-lintel-app` starter, MCP server for agents (`lintel-mcp`) with owner-set spending limits | Works, mined (SDK sale) | [SDK](sdk.md#live-on-testnet) · [Agents](agents.md) |

## Not yet

| Item | State | Why it matters |
| --- | --- | --- |
| Mainnet | Not planned until testnet is solid and reviewed | Lintel has not been through the [Production gate](production.md). Do not use it with real funds. |
| External audit | Not done | The guarantees are backed by tests and live testnet runs, not by an outside review. |
| On-chain settlement for multi-copy listings | Not done | Presale sales complete through the relay and move no coins; their sighash and randomizer are placeholders. Treat presale copies as free. |
| Hosted seller agent | Not offered | The agent holds the listing's signing share and adaptor secret, so it runs on a machine the seller controls. |
| Full wallet | Not done | The app's built-in testnet wallet only knows notes you scan in by txid and does not track spends made elsewhere (the SDK's `wallet.sync` scans compact blocks and tracks spends). |
| SDK and MCP on npm | Not published | `lintel-sdk`, `create-lintel-app` and `lintel-mcp` build from this repo; publishing needs the maintainer's npm account. |
| Refund backup | Not done | The signed refund lives only in the buyer's browser storage. Clearing site data while an escrow is open loses it. |
| Confidentiality after a sale | Not provided | After a single-copy sale settles, the key can be computed by anyone who reads the sale's public session record on the relay together with the mined settlement. Lintel guarantees a fair exchange, not exclusivity after it. See the [Threat model](threat-model.md#after-the-sale). |
| Relay privacy for escrows | Not provided | The relay operator can derive the escrow viewing key from the public session fields and see escrow balances. It cannot spend them. |
| Fast big-file sealing in a browser tab | Not done | About 100 s per 23.8 KB part single-threaded, so a 1 MB file takes over an hour in a tab. Natively, 1 MB took 9.5 minutes on 2 vCPU. The threaded build was not benchmarked for big offers. |
| Blob garbage collection on the relay | Not done | Blob uploads are open (size and quota capped) and unreferenced blobs are not removed. |
| More claim types (signed attestations, dataset predicates) | Design only | `docs/predicates.md` sketches them; only the `Format` predicate (length, prefix, bytes at an offset) is implemented. Claims need offer v3 (a short file with claims pays for one big-part proof) and byte claims must lie in the first 23,777 bytes. The SDK and MCP server do not expose claims yet: claims are made and checked in the web app. |
| "Proven core + bulk" for files over 1.5 MB | Not done | Everything sold today is fully proven; nothing larger is offered. |
| Min-value disclosure in the app | Engine only | `engine/src/disclosure.rs` has a tested circuit; the web app does not use it. |

## Order of work

1. Make testnet solid: fix what testers report, close the gaps above that affect funds or secrets first (refund backup, post-sale confidentiality), and keep every change covered by tests and a live run.
2. Internal review of the engine, circuits, relay and app, with a public remediation log.
3. External audit.
4. Only then consider mainnet, with caps. The full list is on the [Production gate](production.md).

Found something? Testers report through GitHub issues; security problems go privately per [SECURITY.md](../SECURITY.md).
