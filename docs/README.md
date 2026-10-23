# Lintel documentation

Lintel is pay-to-unlock for Zcash: pay only for what's proven. A seller seals a file in their browser and publishes a zero-knowledge proof that the ciphertext opens, under a secret key, to content with a stated hash. A buyer checks that proof on their own device before paying. The payment is an adaptor signature locked to the same secret, so the transaction that pays the seller is the transaction that hands the buyer the key.

> **Status: testnet only.** Lintel runs on Zcash testnet (TAZ). It has not been audited. Do not use it with real funds.

## The short version

1. **Seal and prove.** The seller encrypts the content under a fresh secret `t` and proves in Halo 2 that the ciphertext decrypts, under the secret behind the public point `T = [t]·G`, to content with hash `h`.
2. **Pay into escrow.** The buyer verifies the proof, then funds a shielded escrow whose spend key is the sum of both parties' key shares. Before funding, the seller co-signs a refund that consensus rejects until the seller's claim window has closed.
3. **Settlement reveals the key.** To get paid, the seller completes the adaptor signature and broadcasts the settlement. The buyer reads the completed signature from the mined transaction, computes `t = s − s_a − s_b`, and decrypts.

Proving, signing, transaction building and verification all run in the browser (Rust compiled to WebAssembly). A seller can instead hand an on-chain listing to the seller agent (`lintel-agent`), which runs the seller's side natively on a machine they control. A small relay passes public messages and proxies public chain data. It never sees key shares, `t` or plaintext.

## Two kinds of listing

| | Single-copy listing | Multi-copy (presale) listing |
| --- | --- | --- |
| Settles | On Zcash testnet (escrow, refund, settlement) or as an off-chain demo | Off-chain: the completed signature goes through the relay, no ZEC moves |
| Copies | 1 | Up to 10 from the Sell form (20 per listing on the relay), each with its own secret |
| Payload | Up to 1.5 MB (1,523,681 bytes): one proof up to 1,953 bytes, then one proof per 23.8 KB part | Up to 1.5 MB: up to four small proofs up to 7,905 bytes, then one proof per 23.8 KB part |
| Buyer pays from | The in-browser testnet wallet, or any testnet wallet via a ZIP 321 request (transparent or shielded) | Nothing moves |
| Seller online? | The seller's app or the seller agent (`lintel-agent`) must be running while a buyer pays | No: buyers order while the seller is away; the sale completes the next time the seller's app is open |

## Where to go next

- [Quickstart](quickstart.md): check a proof in two minutes, then buy and sell on testnet in the browser.
- [What ships when](what-ships-when.md): what works on testnet today and what does not exist yet.
- [How it works](how-it-works.md): adaptor signatures, sealed goods, settlement and the time-locked refund.
- [Proven claims](predicates.md): public claims about the content (length, magic prefix, bytes at an offset), proven in the same proof as the decryption.
- [Security model](security-model.md): what each party and the relay can see and do, and the known limits.
- [Threat model](threat-model.md): attacker by attacker, with mitigations and residual risk.
- [How Lintel compares](compare.md): trusted escrow, ZKCP on Bitcoin, plain Zcash trades, FHE/MPC data markets and shielded pools.
- [Architecture](architecture.md): engine, WASM, relay and app, and what never leaves your device.
- [Self-hosting](self-hosting.md): run your own relay (Render + Upstash) and app (Vercel).
- [CLI reference](cli.md): `lintel-cli`, `lintel-chain` and the seller agent `lintel-agent`.
- [FAQ](faq.md) and [Testnet evidence](testnet-evidence.md).

Deep dives: [On-chain settlement](onchain.md) (full design notes and test record, including the seller agent and paying from another wallet), [Presale, relay and proving](relay-perf.md), [Big payloads](big-payloads.md) (offer v3: proven 23.8 KB parts, rate-2 keystream, content-addressed blobs, benchmarks) and [Proven claims](predicates.md) (predicates: length bounds, magic prefix and bytes at an offset, proven over the same plaintext; signed-attestation and dataset designs). Deeper: the [Whitepaper](whitepaper.md) (construction, circuits, security argument, benchmarks) and the [Production gate](production.md) (what must be true before any mainnet). History: the [early design note](settlement.md) from the first CLI prototype.

On the site: [Verify a listing](https://lintel-godwin-web3s-projects.vercel.app/verify), [How it works](https://lintel-godwin-web3s-projects.vercel.app/how-it-works), [Use cases](https://lintel-godwin-web3s-projects.vercel.app/use-cases), [Evidence](https://lintel-godwin-web3s-projects.vercel.app/evidence), [Become a tester](https://lintel-godwin-web3s-projects.vercel.app/testers) and the [Blog](https://lintel-godwin-web3s-projects.vercel.app/blog).

## Live deployment

- App: <https://lintel-godwin-web3s-projects.vercel.app>
- Relay: <https://lintel-relay.onrender.com> (`GET /health`)
- Source: <https://github.com/Godwin-web3/lintel>
