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
| **Relay operator** | Read every public field; see escrow balances (it can derive the viewing key from the session fields); drop, delay or withhold listings, messages and blobs | Forge proofs, signatures or transactions; substitute a blob (SHA-256 names are checked by the relay, the app and the engine); spend an escrow; block a refund (refunds only need the chain) |
| **lightwalletd or the chain proxy** | Lie about or withhold chain data, which can make a proof or broadcast fail | Make the buyer accept a wrong key: the buyer verifies the extracted signature against its own `rk` and sighash; the browser cross-checks witness roots against `GetTreeState` |
| **Network observer** | See on chain that a shielded transaction happened, the transparent 20,000-zat lock coin in the funding transaction and its spend by a refund, and, for transparent pay-in, the payment to the pay-in t-address | Read shielded amounts or addresses; learn `t` from the chain alone (it also needs `s_a` and `s_b`, see [after the sale](#after-the-sale)) |
| **App host** (whoever serves the web app) | Serve modified code that leaks secrets | Nothing the protocol can stop. Self-hosting from a reviewed commit removes this dependency ([Self-hosting](self-hosting.md)) |
| **Anyone** | Upload blobs that hash to their name, up to `MAX_BLOB` each and `BLOB_QUOTA` in total; create listings up to `MAX_LISTINGS` | Make a listing reference a blob the relay does not hold |

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
| Network upgrade between building and using a refund | The refund is signed for the current consensus branch | It would need re-signing after an upgrade |
| Relay withholds a blob or message | Stalls the sale. Before payment the buyer cannot verify, so does not pay; after funding the refund needs only the chain | Liveness, not safety |
| Malicious app build | CSP blocks external scripts and fonts; parameter files are pinned by digest inside the WASM | A host serving different code defeats every in-browser guarantee. Self-host or check the build |
| Loss of browser storage mid-sale | Warnings in the app and docs; pay-in wallets offer a backup file | The signed refund has no backup yet: clearing site data while an escrow is open loses it |
| Theft of the handoff file or agent directory | Documented as secret; the agent runs on a machine the seller controls | Anyone with the file can complete the sale (the payout still goes to the address in the file) and learns `t`, so the content leaks |
| Blob spam | Size cap per blob and total quota | Unreferenced blobs are not garbage-collected yet |

## After the sale

Lintel guarantees a **fair exchange**: the seller is paid if and only if the key becomes available to the buyer. It does **not** keep the content exclusive to the buyer after that.

In a single-copy on-chain sale, the seller's partial signature `s_b` and the buyer's pre-signature `s_a` are written to the sale's session record on the relay, which the relay serves publicly (`GET /sessions/:id`). Once the settlement is mined, its completed signature `s` is public on chain, so anyone who reads both can compute `t = s − s_a − s_b` and decrypt the listing's ciphertext, which is also public. The relay operator can always do this. Treat the content of a settled single-copy listing as public from then on.

This matches other contingent-payment designs, where the key released on chain opens the ciphertext for anyone who has it. Multi-copy listings differ: the relay stores `s_a`, `s` and `s_b` masked under a buyer-seller Diffie-Hellman key, which is not enough to derive `t_i`; but those sales do not move coins yet.

Closing this for single-copy sales (for example, keeping `s_b` off the public record) is on the list in [What ships when](what-ships-when.md).

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
