# Lintel: proven-before-paid data sales on Zcash

**Technical paper · testnet edition · October 2026**

> Lintel runs on Zcash testnet only and has not been audited. This paper describes the code in this repository as it is, including what it does not do. Every measurement is taken from the repository's own records; the source document is named next to each.

## Abstract

Lintel lets a seller sell a file to a buyer who does not trust them, with no one in the middle holding money, keys or content. The seller encrypts the file under a fresh secret `t` and publishes Halo 2 proofs that the ciphertext decrypts, under the secret behind the public point `T = [t]G`, to content with a stated hash `h`. The buyer checks those proofs on their own device, then funds a shielded Zcash escrow whose spend key is split between the two parties. The escrow can only be spent with a signature that the seller completes from an adaptor pre-signature locked to `T`; publishing that signature reveals `t` to the buyer. A refund co-signed before funding, and time-locked by consensus, returns the funds if the seller never settles. Payloads of up to 1,523,681 bytes are supported with every byte's decryption proven. The full flow has been run and mined on Zcash testnet from the browser, from a separate seller process, and with funding paid from an external wallet.

## 1. Problem

Some things are only worth paying for if they are exactly what was promised, and only safe to hand over once paid: a vulnerability report for a bounty, a dataset, a piece of research, a licence key. Two strangers trading such a thing face a fair-exchange problem: whoever goes first can be cheated. The usual answer is a trusted intermediary that holds the money and inspects the goods. That intermediary sees everything, can be breached or coerced, and charges for the service.

Lintel's goal is narrower and fully mechanical:

1. **Correctness before payment.** The buyer learns, before any money moves, that the sealed content has the hash they expect.
2. **Atomicity.** The seller is paid if and only if the buyer obtains the key.
3. **Refundability.** If the seller never settles, the buyer gets the money back without the seller's cooperation at that time.
4. **No custodian.** No server holds funds, key shares, the unlock secret or plaintext.
5. **Payment privacy.** Amounts and parties stay in Zcash's shielded pool.

It does not try to judge whether content is worth its price, and it does not keep content secret from third parties after a sale (see section 9.3).

## 2. Model

**Parties.** A seller (who holds the content and later the secret `t`) and a buyer. In the engine source, `protocol.rs` names these roles the other way round for historical reasons; `chain.rs` and the browser code call them merchant and payer. This paper uses buyer and seller throughout.

**Relay.** A small public server that stores listings, write-once session fields and content-addressed blobs, and proxies public chain calls to lightwalletd. It is trusted for availability only.

**Chain.** Zcash testnet at NU7: the escrow is a shielded note in the Ironwood pool (same key structure and RedPallas spend authorization as Orchard), built as v6 transactions.

**Devices.** Proving, signing, transaction building and verification run in each party's browser (Rust compiled to WebAssembly, in a Web Worker), or, for the seller, optionally in a native seller agent (`lintel-agent`) on a machine the seller controls.

**Adversaries.** Either party may deviate arbitrarily. The relay operator may read everything it stores and drop or delay anything. Chain data sources may lie. The app host is trusted to serve the code in the repository (section 9.4).

## 3. Construction overview

All three components are tied to one secret `t` and its public point `T`:

1. **Seal and prove.** The seller samples `t`, encrypts the content under a Poseidon keystream derived from `t`, and proves that the ciphertext opens to content with hash `h` and that `T = [t]G` on the Orchard spend-authorization base.
2. **Verify and fund.** The buyer verifies the proofs against the listing's `T` and `h`. Both parties set up a joint escrow key; the seller co-signs a time-locked refund; the buyer funds.
3. **Settle and unlock.** Both sides check the settlement transaction; the buyer gives an adaptor pre-signature locked to `T`; the seller completes it with `t` and broadcasts; the buyer reads the completed signature from the mined transaction, computes `t` and decrypts.

## 4. Circuits

All circuits use Halo 2 with the inner-product argument over the Pasta curves, so there is no trusted setup. Public parameter files are downloaded by the browser and pinned by BLAKE2b digest inside the WASM; a substituted file is rejected (source: [How it works](how-it-works.md), [Big payloads](big-payloads.md)).

### 4.1 Single proof (offer v1)

Payload up to 1,953 bytes: 64 chunks of 31 bytes, chunk 0 carrying the length. Public inputs `[T.x, T.y, h, c_0 … c_63]`. The circuit proves:

- `T = [t]G` on the Orchard spend-auth base, the same `T` the payment will be locked to;
- `c_i = m_i + Poseidon(t, i + 1)` for each chunk;
- `Poseidon(m) = h`.

`t` is sampled below the Pallas base-field modulus so it is valid both as a scalar and as a field element. Circuit size k = 13; parameters `params.bin`, 524,356 bytes, BLAKE2b `f1a631a8…53b97db2`.

### 4.2 Multi-proof (offer v2)

Up to four k = 13 proofs bound to the same `t`, each with a public keystream offset; verifiers require `off_j = 64·j`, so no two parts share keystream. Content hash: the part hash for one part, `BLAKE2b("lintel-mpart-v1", P ‖ h_0 ‖ …)` for more. Maximum 7,905 bytes; used for multi-copy listings (source: [Presale, relay and proving](relay-perf.md#e-payloads-larger-than-1953-bytes)).

### 4.3 Big payloads (offer v3)

Up to 64 proofs at k = 15, each covering 768 field elements (23,808 bytes), for a maximum of 1,523,681 bytes. For part `j`, public inputs `[T.x, T.y, h_j, off_j, c_{j,0} … c_{j,767}]`, and the circuit proves:

- `T = [s]G` on the Orchard spend-auth base;
- `(o_0, o_1) = squeeze2(Poseidon-sponge(s, 2^128 + off_j + i + 1))`, with `c_{2i} = m_{2i} + o_0` and `c_{2i+1} = m_{2i+1} + o_1` for each of the part's pairs;
- `Poseidon(m_j) = h_j`.

The verifier requires `off_j = 384·j` and recomputes the listing's content hash as `BLAKE2b-256("lintel-big-v3", 768 ‖ P ‖ h_0 ‖ … ‖ h_{P-1})`, so swapping, dropping or reordering parts fails.

**Rate-2 keystream.** v3 outputs both rate words of each permutation of the width-3 Poseidon sponge (P128Pow5T3), keeping the capacity word hidden, so two payload elements cost two permutations (one keystream, one hash) instead of three. Every permutation input is distinct (`2^128 +` global pair index `+ 1`), and the `2^128` tag keeps v3 inputs disjoint from v1/v2 inputs (below `2^64`), so even a secret reused across versions would not repeat keystream. Soundness of the proof does not depend on keystream secrecy: both squeezed words are constrained by the same Pow5 chip gates (source: [Big payloads](big-payloads.md#2-rate-2-keystream)).

Parameters `params-big.bin`, 2,097,220 bytes, BLAKE2b (personal `lintel-params-v1`) `0544c622…e9004e73`, fetched only when a big offer is first sealed or verified.

**Blobs.** Each v3 part (header, ciphertext, proof) is stored on the relay as a blob named by its SHA-256. The listing carries a manifest of about 170 bytes per part. Integrity is checked by the relay on upload, by the app on download, and by the engine against the manifest before any proof is verified.

### 4.4 Proven claims (predicates)

A v3 offer may carry public claims about the content, proven in part 0 over the same plaintext cells the circuit decrypts and hashes. The implemented predicate, `Format`, covers one length claim (`min ≤ len ≤ max`, with `len` the packed length word) and up to two byte claims (a magic prefix, or 1 to 32 bytes at an offset within the first 23,777 bytes). Each selected 31-byte chunk is decomposed into bytes range-checked with the existing 10-bit lookup, compared under public masks, and three 40-bit range checks give the length bounds and stop a byte claim from pointing into zero padding. The claim parameters (253 field elements) are public inputs, so a changed claim fails verification; claims the seller did not make get vacuous parameters, so one verifying key serves every combination. The circuit stays at k = 15 with the same `params-big.bin`; proving one part costs about 3% more CPU and the proof grows by 64 bytes. Offers without claims use the unchanged circuit, whose verifying key is pinned in a test. Signed attestations and dataset predicates are designs, not code (source: [Proven claims](predicates.md)).

### 4.5 What the proofs do not say

They show that the content matches `h`, and any proven claims about its length and bytes, not that `h` is the content the buyer wants. The claims narrow what a buyer must take on trust (a file that starts with `%PDF-` and is between two lengths), but they say nothing about meaning or quality. The buyer still needs an out-of-band reason to expect `h`, such as a hash the seller published earlier.

## 5. Adaptor-signature settlement

Arithmetic is on the Pallas curve with the Orchard spend-authorization base `G`. A RedPallas signature on a message is `(R, s)` with `s·G = R + c·rk`, where `c = H(R ‖ rk ‖ sighash)` and `rk = ak + α·G` is the re-randomized spend key.

Key and nonce are split, and the seller's point `T` is added to the nonce:

```
rk = vk_a + vk_b + α·G          (vk_a = sk_a·G buyer, vk_b = sk_b·G seller)
R  = R_a + R_b + T              (R_a = r_a·G, R_b = r_b·G)
c  = H(R ‖ rk ‖ sighash)
```

1. The buyer draws a single-use nonce and publishes `R_a`.
2. The seller returns `s_b = r_b + c·sk_b` and a proof of knowledge of `sk_b` (domain `Lintel_PoK_v1`).
3. The buyer checks the proof and `s_b·G = R_b + c·vk_b`, recomputes `R` and `rk`, and sends the pre-signature `s_a = r_a + c·(sk_a + α)`.
4. `(R, s_a + s_b)` is short of a valid signature by exactly `t`. Only the seller can complete it: `s = s_a + s_b + t`.
5. On seeing `s`, the buyer computes `t = s − s_a − s_b`.

The buyer pre-signs only for the `T` returned by its own proof verification, so the key it will extract is the key the ciphertext is encrypted under.

## 6. The escrow

**Joint key.** `ak = vk_buyer + vk_seller`. Orchard requires the sign bit ỹ(ak) = 0; when the sum has ỹ = 1, both parties negate their own share, decided from the public keys alone. `nk` and `rivk` are derived from 32-byte contributions from each side with `BLAKE2b-512("Lintel_JointFVK_", …)`. Before funding, each side verifies the other's proof of knowledge of its share, which rules out a rogue-key choice `vk = K − vk_peer` (source: [On-chain settlement](onchain.md#2-joint-adaptor-key--the-notes-ak)).

**What is signed.** `sighash` is the shielded sighash of the agreed PCZT and `α` is the escrow action's randomizer from it. Both parties run `chain::check_spend` on the same PCZT bytes and sign only what their own check returns; it rejects a wrong amount or recipient, change to anyone but the buyer, a fee other than the ZIP 317 fee, a wrong expiry or consensus branch, and extra spends. The completed signature is verified with `reddsa` before it is applied, and the PCZT extractor verifies proofs and signatures before writing the transaction.

**Unlocking from the chain.** The seller broadcasts the settlement itself. The buyer fetches the mined transaction, finds the signature by its agreed nonce commitment `R`, verifies `(R, s)` under its own `rk` and sighash, and only then extracts `t`. The source of the transaction bytes therefore does not need to be trusted.

## 7. Refund

Zcash enforces `nLockTime` only through transparent inputs, so a shielded-only refund would be valid immediately, and a buyer could read `t` from a settlement in the mempool and race a conflicting refund (the v1 design had this race). The v2 refund closes it at the consensus layer:

- Funding also pays a 20,000-zat transparent lock coin to an address the buyer owns, at output 0.
- The refund spends the escrow and that coin with `nSequence = 0xfffffffe` and `nLockTime = H_lock`; consensus rejects it at any height `≤ H_lock`.
- The settlement carries an expiry height `E`. The seller co-signs a refund only if `H_lock ≥ E` (`chain::check_refund_window`), so settlement and refund are never valid at the same height.
- The signature commits to `nLockTime`, the transparent input and its sequence (ZIP 244), so the buyer cannot loosen the lock after the seller signed.

The refund is co-signed before funding: build funding (unbroadcast), co-sign the refund, store it, then broadcast funding. The refund session is the normal protocol with the seller's adaptor secret fixed to zero. In the browser app, `E` is the chain tip plus 60 blocks (about 75 minutes), the refund locks until `E`, and the seller refuses to settle within 10 blocks of `E`. The refund returns the escrow minus a 15,000-zat fee, plus the lock coin. On testnet the node rejected a pre-signed refund before its lock height ("transaction is locked until after block height") and accepted the identical bytes after it (source: [How it works](how-it-works.md#5-the-time-locked-refund-v2), [Testnet evidence](testnet-evidence.md#v2-time-locked-refund-cli)).

## 8. Variants

**Multi-copy listings.** Selling one `t` twice would leak it, so each copy is sealed separately with its own `sk_i`, `r_i`, `t_i`, ciphertext and proofs. With the seller's nonce fixed in advance, a buyer can pre-sign while the seller is offline, sending an ephemeral Diffie-Hellman point; the seller later publishes `s` and `s_b` masked under the DH key. Each copy signs at most once. These sales are not wired to the chain yet: the completed signature reaches the buyer through the relay and no coins move.

**Pay from another wallet.** The buyer's app opens a per-purchase pay-in wallet and shows a ZIP 321 request for the escrow, the lock coin and the funding fee. Any testnet wallet can pay it, to a shielded (Orchard receiver, Ironwood note) or transparent address; the escrow is funded straight from that payment, so the refund can still be pre-signed over the exact escrow note.

**Seller agent.** `lintel-agent` imports a handoff file holding one listing's signing share, adaptor secret and relay token and runs the seller's side natively, re-running every check the app makes. It holds no wallet spending key; payouts go to the address in the handoff.

## 9. Security argument

This is an informal argument, not a proof, and it has not been externally reviewed.

### 9.1 Buyer safety

- *The buyer does not pay for the wrong content.* By soundness of the circuits, a verifying offer means the ciphertext decrypts under the discrete log of `T` to content hashing to `h`. The buyer pre-signs only for that `T`.
- *The buyer gets the key if the seller is paid.* The escrow can only be spent with a valid signature under `rk`. Given `s_a` and `s_b`, any valid completion of the agreed `R` reveals `t = s − s_a − s_b`. The buyer reads `s` from the chain, not from the relay.
- *The buyer is not stuck.* The refund exists, co-signed, before funding, and becomes valid after `H_lock`.

### 9.2 Seller safety

- *The buyer does not get the content without paying.* Before settlement the buyer holds the ciphertext, `T` and `s_b`. Recovering `t` from `T` is the discrete-log problem; the keystream is a keyed Poseidon sponge with `t` as the key.
- *The buyer cannot take both.* The refund is invalid until after the settlement's expiry, so once the settlement is mined within its window the escrow note is spent and the refund can never be mined.
- *Neither party can spend alone.* Spending needs `sk_a + sk_b`; proofs of knowledge prevent rogue keys.

### 9.3 Limits of the argument

- **After the sale.** In a single-copy sale, `s_a` and `s_b` are written to the relay's public session record. Once `s` is on chain, anyone who reads both can compute `t` and decrypt the listing's public ciphertext. Lintel provides fair exchange, not exclusivity after it. ZKCP on Bitcoin has the same property, since its key is published in the redeeming transaction. Multi-copy listings mask `s_b`. See the [Threat model](threat-model.md#after-the-sale).
- **Liveness.** The relay can stall a sale. Before payment that is harmless; after funding, the refund needs only the chain.
- **Escrow privacy from the relay.** Contributions and verification keys posted to the relay let its operator derive the escrow viewing key. It can see but not spend.
- **Local state.** The signed refund lives only in the buyer's browser storage.

### 9.4 Assumptions

Soundness of Halo 2 (IPA, Pasta curves) and of the circuits' constraints; the PRF security of the keyed Poseidon sponge; discrete log on Pallas; Zcash testnet consensus enforcing `nLockTime` and Ironwood spend rules; and the app host serving the repository's code (self-hosting removes that dependency).

## 10. Benchmarks

All numbers are from the repository's records, on a 2-vCPU aarch64 sandbox with 8 GB RAM unless noted.

**Per proof, native** (source: [Big payloads](big-payloads.md#measurements)):

| Circuit | Payload per proof | Setup | Prove | Verify | Proof size | Peak memory |
| --- | --- | --- | --- | --- | --- | --- |
| v1/v2, k = 13, 64 elements | 1,953 B | 6.8 s | 3.30 s | 0.056 s | 4,352 B | 260 MB |
| v3, k = 15, 768 elements | 23,777 B | 29.1 s | 13.3 s | 0.19 s | 4,480 B | 1,028 MB |

Proving cost per byte: 1.69 ms for v1, 0.56 ms for v3.

**Whole payloads, v3, native:** 47,585 B in 2 parts proves in 26.6 s and verifies in 0.37 s; 1,023,713 B (1 MB) in 43 parts proves in 571 s (9.5 minutes) and verifies in 7.8 s, with peak memory 1,034 MB.

**Browser engine (WASM, single thread):** a 30,000 B, 2-part payload took 42.1 s to build keys from `params-big.bin`, 103 s per part to prove, 2.9 s to verify, about 1 GB of WASM memory. Extrapolated for 1 MB: about 74 minutes to prove and about 63 s to verify.

**Browser sealing, small offers** (headless Chromium, `web/app/scripts/bench.mjs`; source: [Presale, relay and proving](relay-perf.md#prove-times)):

| Engine | Boot | Seal 1,000 B (1 proof) | Seal 3,000 B (2 proofs) |
| --- | --- | --- | --- |
| Single thread | 12.2 s | 28.0 s | 55.5 s |
| Threaded, 2 workers | 7.6 s | 15.1 s | 29.9 s |

**End to end on testnet:** a browser sale with both sides in the web app took 6 minutes 34 seconds from start to decrypted content (record `docs/testnet/evidence-browser-settle.json`). Funding and settlement each wait for a block, about 75 seconds on testnet.

## 11. Implementation and evidence

| Part | Path |
| --- | --- |
| Engine: adaptor signatures, circuits, sealed goods, presale, chain, seller agent | `engine/` (Rust crate `lintel`) |
| Browser engine | `wasm/` (crate `lintel-wasm`) |
| Relay | `web/relay/` (Node) |
| App, site and docs | `web/app/` (React + Vite) |

Mined testnet transactions for every on-chain flow (browser sale and refund, CLI settle and time-locked refund, seller agent sale, two sales paid from another wallet) are listed with their heights in [Testnet evidence](testnet-evidence.md) and as JSON in `docs/testnet/`. The first browser sale was funded at block 4,522,583 and settled at 4,522,588.

## 12. Status and next steps

Lintel is testnet software. Mainnet is not planned until testnet is solid and the code has been reviewed internally and externally; the conditions are written down on the [Production gate](production.md) page, and the current feature status is on [What ships when](what-ships-when.md). The nearest work: refund backup outside browser storage, keeping `s_b` off the public record for single-copy sales, on-chain settlement for multi-copy listings, and faster big-file sealing in the browser.

## References

- Zero Knowledge Contingent Payment, Bitcoin Wiki: <https://en.bitcoin.it/wiki/Zero_Knowledge_Contingent_Payment>
- M. Campanelli, R. Gennaro, S. Goldfeder, L. Nizzardo, *Zero-Knowledge Contingent Payments Revisited: Attacks and Payments for Services*, ACM CCS 2017: <https://eprint.iacr.org/2017/566>
- ZIP 244, Transaction Identifier Non-Malleability: <https://zips.z.cash/zip-0244>
- ZIP 317, Proportional Transfer Fee Mechanism: <https://zips.z.cash/zip-0317>
- ZIP 321, Payment Request URIs: <https://zips.z.cash/zip-0321>
- ZIP 374: <https://zips.z.cash/zip-0374>
- The halo2 book: <https://zcash.github.io/halo2/>
