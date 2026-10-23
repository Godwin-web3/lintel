# How it works

Lintel combines three pieces: a two-party **adaptor signature** that can only be completed by revealing a secret `t`, a **Halo 2 proof** that a ciphertext is encrypted under that same `t`, and a Zcash **escrow** whose spend needs the completed signature. This page explains each and how they fit. The design notes with every check and test are in [On-chain settlement](onchain.md) and [Presale, relay and proving](relay-perf.md).

## Roles and names

| In this documentation | Holds | In `engine/src/protocol.rs` | In `engine/src/chain.rs` |
| --- | --- | --- | --- |
| **Buyer** | key share `sk_a`, single-use nonce `r_a` | `Seller` (historical name: the party that pre-signs) | payer |
| **Seller** | key share `sk_b`, nonce `r_b`, unlock secret `t` | `Buyer` (the party that completes and holds `t`) | merchant |

The protocol module predates the marketplace and names its roles the other way round. The browser code (`web/app/src`) and `chain.rs` use payer and merchant, which match buyer and seller here.

All arithmetic is on the Pallas curve with the Orchard spend-authorization base `G`. Signatures are RedPallas (Schnorr) signatures, the same kind Zcash uses to authorize Orchard and Ironwood spends.

## 1. The adaptor signature

A RedPallas signature on a message is a pair `(R, s)` with `s·G = R + c·rk`, where `c = H(R ‖ rk ‖ sighash)` and `rk = ak + α·G` is the re-randomized spend key.

Lintel splits both the key and the nonce between the two parties and adds the seller's secret point `T = t·G` to the nonce:

```
rk = vk_a + vk_b + α·G          (vk_a = sk_a·G buyer, vk_b = sk_b·G seller)
R  = R_a + R_b + T              (R_a = r_a·G, R_b = r_b·G)
c  = H(R ‖ rk ‖ sighash)
```

1. The buyer generates a single-use nonce inside its signer and publishes only `R_a`.
2. The seller answers with its partial `s_b = r_b + c·sk_b` and a proof of knowledge of `sk_b` (a separate hash domain, `Lintel_PoK_v1`). It never sees `r_a`. The partial goes through the relay with `s_b` masked to the buyer, `enc_sb = s_b + H(sk_b·vk_a, R_b, T)` (domain `Lintel_sbmask_v1`); the buyer removes the mask with `sk_a·vk_b`, the same point. Without the mask, `s_a` and `s_b` on the relay plus `s` on chain would give `t` to anyone ([Threat model](threat-model.md#after-the-sale)).
3. The buyer checks that proof and `s_b·G == R_b + c·vk_b`, recomputes `R` and checks `rk`, then sends its pre-signature `s_a = r_a + c·(sk_a + α)`. The nonce is consumed on use.
4. `(R, s_a + s_b)` is **not** a valid signature: it is short by exactly `t`. Only the seller can finish it: `s = s_a + s_b + t`, which verifies under `rk`.
5. As soon as the buyer sees `s`, it computes `t = s − s_a − s_b`.

So the completed signature is the payment, and publishing it is what hands `t` to the buyer. Neither side can produce a valid signature alone: the buyer lacks `sk_b` and `t`, the seller lacks `sk_a`.

Peer-supplied values are parsed with `parse_scalar` and `parse_point`, which return an error on malformed input rather than panicking.

## 2. Sealed goods: verifiable encryption under `t`

The adaptor signature guarantees the buyer learns `t`. Sealed goods (`engine/src/sealed.rs`) make `t` worth something: before any money moves, the seller encrypts the payload under `t` and proves, in a Halo 2 circuit:

- `T = t·G` on the Orchard spend-auth base, the same `T` the signature is locked to;
- `c_i = m_i + Poseidon(t, i+1)` for each 31-byte chunk: the ciphertext is the plaintext under a keystream derived from `t`;
- `Poseidon(m) = h`: the plaintext matches the content hash `h` in the listing.

Public inputs are `[T.x, T.y, h, c_0 … c_63]`. The buyer runs `verify_offer` against the `T` of the sale before pre-signing. A wrong content hash, a tampered ciphertext, or a key not bound to `T` all fail verification.

| | |
| --- | --- |
| Payload per proof | up to 1,953 bytes (64 chunks of 31 bytes; chunk 0 holds the length) |
| Larger payloads | up to 4 proofs bound to the same `t` with a public keystream offset each, 7,905 bytes (`sealed_multi.rs`) |
| Big payloads | up to 64 proofs of 768 elements (23,808 bytes) each at k = 15 with a rate-2 Poseidon keystream, 1,523,681 bytes; ciphertext and proofs in SHA-256-named relay blobs (`sealed_big.rs`, [Big payloads](big-payloads.md)) |
| Proof size | about 4.3 KB |
| Proving | about 3.3 s per small proof natively; 15 to 30 s in a browser. A 23.8 KB v3 part: 13.3 s natively on 2 vCPU, about 100 s in a single-threaded browser tab |
| Verifying | about 0.5 s in a browser |
| Setup | none trusted: Halo 2 with IPA over the Pasta curves |

`t` is sampled below the Pallas base-field modulus so it works both as a scalar and as a field element. The browser downloads pinned proving parameters (`params.bin`, 524,356 bytes) instead of regenerating them; their BLAKE2b digest is pinned in the WASM and a substituted file is rejected.

**What the proof does not say:** it shows the content matches `h`, not that `h` is the content the buyer wants. The buyer needs to know which hash to expect, for example one the seller published or someone attested out of band.

**Proven claims** narrow that gap. A seller can attach public claims to a v3 offer: the payload's length lies between two bounds, it starts with given bytes (a file signature such as `%PDF`), or the bytes at an offset equal a public value. Part 0's proof is then made with a second circuit (`predicate::Format`) that adds those checks over the same plaintext cells it decrypts and hashes, with the claim's parameters as extra public inputs. The buyer's app verifies part 0 against the claims and shows them in plain English next to the verified proof. Offers without claims use the unchanged circuit. See [Proven claims](predicates.md).

## 3. Min-value disclosure (engine only)

`engine/src/disclosure.rs` contains a second Halo 2 circuit for selective disclosure: it proves `value ≥ min` (a 64-bit range check on `value − min`) and that `C = Poseidon(value, blind, txid_lo, txid_hi)`, with public inputs `[min, txid_lo, txid_hi, C]`. Binding the txid means a proof for one transaction does not verify for another. The circuit has real prove and verify tests, but the web app does not use it yet.

## 4. On-chain settlement

For single-copy listings, the signature above authorizes a real Zcash testnet spend.

**The escrow.** Both parties derive a joint key with `ak = vk_payer + vk_merchant` (if the sum has the wrong sign bit, both negate their own share, decided from the public keys alone). `nk` and `rivk` are derived from 32-byte contributions from each side. The escrow is a shielded note in the **Ironwood** pool (NU6.3+, same key structure and RedPallas spend authorization as Orchard) on the NU7 testnet, built as **v6** transactions. Spending it needs a signature under `rk = ak + α·G`, so neither party can spend it alone. Before funding, each side checks the other's proof of knowledge of its share, which rules out a rogue-key attack where one party publishes `vk = K − vk_peer`.

**What gets signed.** Not a placeholder: `sighash` is the shielded sighash of the agreed PCZT, and `α` is the escrow action's `alpha` from it. Both parties run `chain::check_spend` on the same PCZT bytes and sign only what their own check returns. It rejects anything else: wrong amount or recipient, change to anyone but the buyer, a fee other than the ZIP 317 fee, wrong expiry or consensus branch, extra spends. The completed signature is checked with `reddsa` before it is applied, and the PCZT extractor fully verifies proofs and signatures before writing the transaction.

**Order of a browser sale:**

1. Buyer and seller exchange keys, contributions and proofs of knowledge through the relay, and derive the escrow address.
2. The buyer builds the funding transaction (without broadcasting) and the refund.
3. The seller co-signs the refund. The buyer stores it on its device.
4. The buyer broadcasts funding.
5. The seller builds the settlement (price to the seller, change to the buyer, expiry height `E`), both check it, and they run the adaptor signing.
6. The seller completes the signature, proves the transaction and broadcasts it.
7. The buyer fetches the mined settlement, finds the signature by its agreed nonce commitment `R`, verifies `(R, s)` under its own `rk` and sighash, extracts `t` and decrypts.

Because the buyer verifies the signature it extracts, the source of the transaction bytes does not need to be trusted. In the on-chain flow the relay only ever sees the settlement txid, never a completed signature.

**Who runs each side.** The seller's steps (co-signing the refund, building, signing, proving and broadcasting the settlement) run in the seller's open app, or in the seller agent `lintel-agent`, which imports a handoff file from the app and runs the same checks natively ([CLI reference](cli.md#lintel-agent-seller-agent)). The buyer funds from the in-browser wallet, or pays a ZIP 321 request from any testnet wallet to a per-purchase pay-in wallet, transparent or shielded; the escrow is then funded straight from that payment ([details](onchain.md#pay-from-another-wallet)).

## 5. The time-locked refund (v2)

Zcash enforces `nLockTime` only through transparent inputs, so a shielded-only refund would be valid immediately. A buyer could then watch for the settlement in the mempool, read `t` from it, and race a conflicting refund. v2 closes this at the consensus layer:

- Funding also pays a small transparent coin (20,000 zats) to an address the buyer owns, at output 0.
- The refund spends the escrow **and** that coin, with `nSequence = 0xfffffffe` and `nLockTime = H_lock`. Consensus rejects it in any block at or below `H_lock`.
- The settlement carries an expiry height `E` and cannot be mined after it. The seller co-signs a refund only if `H_lock ≥ E` (`chain::check_refund_window`), so the settlement and the refund are never valid at the same height.
- The signature commits to `nLockTime`, the transparent input and its sequence (ZIP 244), so the buyer cannot loosen the lock after the seller has signed.

In the browser app, `E` is the chain tip plus 60 blocks (about 75 minutes) and the refund locks until `E`. The seller refuses to build or broadcast the settlement within 10 blocks of `E`. On testnet, the node rejected a pre-signed refund before its lock height with a consensus error, and accepted the identical bytes after it ([evidence](testnet-evidence.md)).

The refund returns the escrow minus a 15,000-zat fee, plus the lock coin. It is signed for the consensus branch current when it is built, so a network upgrade before it is used would require re-signing.

## 6. Multi-copy (presale) listings

Selling the same `t` twice would leak it: anyone holding a pre-signature and the completed signature can compute `t`. Presale listings (`engine/src/presale.rs`) instead seal each copy separately at listing time, each with its own key share `sk_i`, nonce `r_i`, secret `t_i`, ciphertext and proofs. The seller publishes `(vk_i, R_i, T_i, PoK_i, offer_i)` per copy.

Because the seller's nonce is fixed in advance, a buyer can pre-sign immediately while the seller is offline: it verifies the proof of knowledge and the offer, computes `s_a`, sends a proof of knowledge of its own share and an ephemeral Diffie-Hellman point `E = e·G`, then drops `sk_a` and `r_a`. The next time the seller's app runs, it checks the order and publishes `s = s_a + s_b + t_i` together with `s_b` masked under the DH key. The buyer unmasks `s_b`, extracts `t_i`, checks `t_i·G = T_i`, and decrypts.

Each `(sk_i, r_i)` signs at most once; the app persists a "used" marker before releasing a completion, and the relay rejects a copy that repeats an `R`, key or `T`. The relay stores `s_a`, `s` and the masked `s_b`, which is not enough to derive `t_i`.

Presale listings are not wired to the chain yet: the completed signature reaches the buyer through the relay and no ZEC moves. A sale cannot complete without the holder of `t_i` online at some point, because completing reveals `t_i`; presale removes every round trip before that.
