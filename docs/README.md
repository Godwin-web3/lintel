# Lintel documentation

Lintel is pay-to-unlock for Zcash. A seller seals a file in their browser and publishes a zero-knowledge proof that the ciphertext opens, under a secret key, to content with a stated hash. A buyer checks that proof on their own device before paying. The payment is an adaptor signature locked to the same secret, so the transaction that pays the seller is the transaction that hands the buyer the key.

> **Status: testnet only.** Lintel runs on Zcash testnet (TAZ). It has not been audited. Do not use it with real funds.

## The short version

1. **Seal and prove.** The seller encrypts the content under a fresh secret `t` and proves in Halo 2 that the ciphertext decrypts, under the secret behind the public point `T = [t]·G`, to content with hash `h`.
2. **Pay into escrow.** The buyer verifies the proof, then funds a shielded escrow whose spend key is the sum of both parties' key shares. Before funding, the seller co-signs a refund that consensus rejects until the seller's claim window has closed.
3. **Settlement reveals the key.** To get paid, the seller completes the adaptor signature and broadcasts the settlement. The buyer reads the completed signature from the mined transaction, computes `t = s − s_a − s_b`, and decrypts.

Proving, signing, transaction building and verification all run in the browser (Rust compiled to WebAssembly). A small relay passes public messages between the two browsers and proxies public chain data. It never sees key shares, `t` or plaintext.

## Two kinds of listing

| | Single-copy listing | Multi-copy (presale) listing |
| --- | --- | --- |
| Settles | On Zcash testnet (escrow, refund, settlement) or as an off-chain demo | Off-chain: the completed signature goes through the relay, no ZEC moves |
| Copies | 1 | Up to 10 from the Sell form (20 per listing on the relay), each with its own secret |
| Payload | Up to 1,953 bytes (one proof) | Up to 7,905 bytes (up to four proofs per copy) |
| Seller online? | Yes, while a buyer pays on chain | No: buyers order while the seller is away; the sale completes the next time the seller's app is open |

## Where to go next

- [Quickstart](quickstart.md): buy and sell on testnet in the browser.
- [How it works](how-it-works.md): adaptor signatures, sealed goods, settlement and the time-locked refund.
- [Security model](security-model.md): what each party and the relay can see and do, and the known limits.
- [Architecture](architecture.md): engine, WASM, relay and app, and what never leaves your device.
- [Self-hosting](self-hosting.md): run your own relay (Render + Upstash) and app (Vercel).
- [CLI reference](cli.md): `lintel-cli` and `lintel-chain`.
- [FAQ](faq.md) and [Testnet evidence](testnet-evidence.md).

Deep dives: [On-chain settlement](onchain.md) (full design notes and test record) and [Presale, relay and proving](relay-perf.md).

## Live deployment

- App: <https://lintel-godwin-web3s-projects.vercel.app>
- Relay: <https://lintel-relay.onrender.com> (`GET /health`)
- Source: <https://github.com/Godwin-web3/lintel>
