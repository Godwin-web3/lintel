# Threat model

Who can attack a Lintel sale, what they can reach, and what stops them. It extends the [Security model](security-model.md), which lists the guarantees; this page goes attacker by attacker and states the residual risk plainly.

> **Testnet only, unaudited.** Everything here describes the current testnet code. It has not been reviewed by an outside party.

## Assets

| Asset | Who holds it | Lost or leaked means |
| --- | --- | --- |
| Buyer's escrowed funds | The joint escrow note (needs both key shares) | Buyer loses the price |
| Seller's payout | Paid by the settlement transaction | Seller is not paid |
| Unlock secret `t` | Seller's browser, or `lintel-agent` after a handoff | Content opens without payment |
| Plaintext content | Seller's device; buyer's device after unlock | Content leaks |
| Key shares `sk_a`, `sk_b` and nonces | Each party's browser memory and `localStorage` | Signatures can be forged or a key extracted from nonce reuse |
| Signed refund | Buyer's browser storage only | Buyer cannot reclaim an unsettled escrow |
| Handoff file | Wherever the seller saved it, then the agent directory | Anyone holding it can complete the sale |

## Actors and what they can do

| Actor | Can | Cannot |
| --- | --- | --- |
| **Dishonest seller** | List content that is worthless but matches its hash; refuse to settle; go offline | Get paid without publishing the completed signature that reveals `t`; make a wrong file pass verification; spend the escrow alone; stop the refund after the lock height |
| **Dishonest buyer** | Fund and walk away; try to refund early; try to take the content without paying | Spend the escrow alone; learn `t` before the settlement is mined; get a refund mined while the settlement is still valid (v2 time lock) |
| **Relay operator** | Read every field it stores; see escrow balances (it can derive the viewing key from the session fields); drop, delay or withhold listings, messages and blobs | Forge proofs, signatures or transactions; substitute a blob (SHA-256 names are checked by the relay, the app and the engine); spend an escrow; block a refund (refunds only need the chain); compute `t` from its records plus the chain (the seller's share `s_b` is stored masked to the buyer, see [after the sale](#after-the-sale)) |
| **lightwalletd or the chain proxy** | Lie about or withhold chain data, which can make a proof or broadcast fail | Make the buyer accept a wrong key: the buyer verifies the extracted signature against its own `rk` and sighash; the browser cross-checks witness roots against `GetTreeState` |
| **Network observer** | See on chain that a shielded transaction happened, the transparent 20,000-zat lock coin in the funding transaction and its spend by a refund, and, for transparent pay-in, the payment to the pay-in t-address | Read shielded amounts or addresses; learn `t` from the chain, even together with the relay's records (see [after the sale](#after-the-sale)) |
| **App host** (whoever serves the web app) | Serve modified code that leaks secrets | Nothing the protocol can stop. Self-hosting from a reviewed commit removes this dependency ([Self-hosting](self-hosting.md)) |
| **Anyone** | Upload blobs that hash to their name, up to `MAX_BLOB` each and `BLOB_QUOTA` in total; create listings up to `MAX_LISTINGS`; read a listing and its sale's status (stage and public txids) | Make a listing reference a blob the relay does not hold; read a sale's session record (partial, pre-signature, keys, addresses, PCZTs), which the relay serves only with the buyer's or seller's token |

## Attacks and mitigations

| Attack | Mitigation | Residual risk |
| --- | --- | --- |
| Seller lists a ciphertext that does not open to the promised content | Halo 2 proof that the ciphertext decrypts under the secret behind `T` to content with hash `h`; the buyer verifies before pre-signing | The proof binds content to `h`, not to what the buyer wants. The buyer must know which hash to expect |
| Seller swaps, drops or reorders parts of a big file | Verifier pins `off_j = 384·j` and recomputes the content hash from the proven part hashes | None known |
| Pre-signature locked to a different `T` than the proof | The buyer pre-signs only for the `T` returned by its own `verifyOffer` | None known |
| Rogue-key attack on the joint escrow key (`vk = K − vk_peer`) | Each side checks the other's proof of knowledge of its share before funding | None known |
| Signing something other than the agreed transaction | Both sides run `chain::check_spend` on the same PCZT and sign only the sighash and `α` their own check returns (amount, recipient, change, ZIP 317 fee, expiry, branch, no extra spends) | None known |
| Buyer reads `t` from the settlement in the mempool and races a refund | v2 refund spends a transparent lock coin with `nLockTime = H_lock ≥ E`; consensus rejects it until the settlement's expiry has passed. Seen live: an early refund was rejected with "transaction is locked until after block height" | None known for v2. v1 refunds had this race and are not used by the app |
| Seller never settles | Refund co-signed before funding; after about 60 blocks (roughly 75 minutes) the buyer broadcasts it | Buyer's funds are locked until then; the refund costs a 15,000-zat fee |
| Seller settles too close to expiry | The seller refuses to build or broadcast within 10 blocks of `E` | A settlement broadcast near the edge can still fail to be mined in time; the buyer then refunds |
| Nonce reuse leaks a key share | Buyer nonces are single-use inside the signer; presale copies persist a "used" marker before releasing a completion; the relay rejects a copy that repeats an `R`, key or `T` | Relies on browser storage not being rolled back |
| Same `t` sold twice | A single-copy listing sells once; multi-copy listings seal each copy under its own `t_i` | None known |
| Outsider computes `t` after a sale from the relay's record and the mined settlement | The seller's `s_b` is published masked to the buyer (partial v2); the relay refuses `s_b` in the clear and serves session records only to the buyer and seller | Records of sales settled before this change hold `s_b` in the clear ([after the sale](#after-the-sale)) |
| Network upgrade between building and using a refund | The refund is signed for the current consensus branch | It would need re-signing after an upgrade |
| Relay withholds a blob or message | Stalls the sale. Before payment the buyer cannot verify, so does not pay; after funding the refund needs only the chain | Liveness, not safety |
| Malicious app build | CSP blocks external scripts and fonts; parameter files are pinned by digest inside the WASM | A host serving different code defeats every in-browser guarantee. Self-host or check the build |
| Loss of browser storage mid-sale | Warnings in the app and docs; pay-in wallets offer a backup file | The signed refund has no backup yet: clearing site data while an escrow is open loses it |
| Theft of the handoff file or agent directory | Documented as secret; the agent runs on a machine the seller controls | Anyone with the file can complete the sale (the payout still goes to the address in the file) and learns `t`, so the content leaks |
| Blob spam | Size cap per blob and total quota | Unreferenced blobs are not garbage-collected yet |

## After the sale

Lintel guarantees a **fair exchange**: the seller is paid if and only if the key becomes available to the buyer. Since the session-privacy change, a settled single-copy sale also does not hand the key to everyone else who can read the relay and the chain.

**How the key stays with the buyer.** The settlement signature is `s = s_a + s_b + t`, and `s` is public once the settlement is mined. The buyer's pre-signature `s_a` is on the relay (the seller needs it). So the seller's partial signature `s_b` is the value that must not be public. The seller publishes it masked to the buyer, the same idea multi-copy listings use: `enc_sb = s_b + H(DH, R_b, T)` with `DH = sk_b·vk_a = sk_a·vk_b`, the Diffie-Hellman point of the two signing shares of the escrow key (partial wire format v2). Only the buyer and the seller (or the seller's agent) hold one of those shares, so only they can unmask `s_b`. The buyer checks the unmasked value against `R_b + c·vk_b` before pre-signing, and checks `t·G = T` after extracting it. Someone holding the relay's whole record of the sale plus the mined settlement has `s`, `s_a` and `enc_sb`; without `s_b` that does not determine `t`, so the public ciphertext stays sealed. Engine tests (`protocol::tests::masked_partial_buyer_extracts_t_outsider_cannot`, the agent sale in `engine/tests/agent.rs`) and a WASM test check exactly this.

**Defence in depth on the relay.** The relay now serves a sale's full session record only to a request carrying the buyer's or the seller's token (the seller agent sends the seller token). Anyone else gets a status view: the stage of the sale and the public funding and settlement txids, with no partial, pre-signature, signature, keys, addresses or PCZTs. The relay refuses a settlement partial with `s_b` in the clear or locked to a different `T` than the listing. A partial in the clear is accepted only for the refund, whose adaptor point is the identity, so it carries no key.

**What is still true:**
- The buyer learns `t` and can share it or the plaintext; nothing stops that. The seller, and whoever runs the seller's agent or holds its handoff file, knows `t` all along.
- The relay operator stores the session fields and can still derive the escrow viewing key and see balances. It cannot unmask `s_b`.
- Sales settled before this change wrote `s_b` in the clear. Their records are no longer served publicly, but anyone who copied them earlier, and the operator of the relay that holds them, can still compute their keys. Treat content sold before the change as exposed.
- An app built before this change (or an old `lintel-agent`) cannot post a settlement partial to an updated relay; it gets an error asking to update. A new buyer app still accepts an old-format partial from a self-hosted relay that did not update, so update relay, app and agent together.
- The masking key is derived from the escrow signing shares themselves. That is standard hashed Diffie-Hellman, but like the rest of the protocol it has not been externally reviewed.

Multi-copy listings work the same way with a per-order ephemeral key (`enc_sb = s_b + H(sk_i·E, …)`); they do not move coins yet.

## Trust assumptions

- Halo 2 (IPA over the Pasta curves) and Poseidon are sound, and the circuits are correctly constrained.
- Zcash testnet consensus enforces `nLockTime` and the Orchard-style (Ironwood pool) spend rules.
- The code running in your browser is the code in this repository.
- The buyer has an out-of-band reason to want the content with hash `h`.

## Out of scope

- Whether the content is worth its price.
- Legal questions about what is sold.
- Denial of service against the public relay beyond its documented limits.

Report a vulnerability privately: [SECURITY.md](../SECURITY.md).
