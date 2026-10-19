# Lintel

Conditional settlement on Zcash using two-party adaptor signatures.

## Flow

`R = R_a + R_b + T`, `rk = vk_a + vk_b + α·G`, `c = H(R ‖ rk ‖ sighash)`.

1. Seller generates a single-use nonce and publishes only `R_a`.
2. Buyer computes `s_b = r_b + c·sk_b` from `R_a` (never sees `r_a`).
3. Seller checks the buyer's knowledge proof and `s_b·G == R_b + c·vk_b`, then sends `s_a`.
4. Buyer recomputes `R = R_a + R_b + T`, checks `vk_hex` against `rk`, and verifies `s_a` before completing.
5. Seller extracts `t = s − s_a − s_b` without learning `sk_b`.

## Sealed goods (pay to decrypt)

`engine/src/sealed.rs` makes "paying reveals the key" mean "paying unlocks the promised content".

The party holding `t` (it completes the signature and gets paid) encrypts a payload and proves in Halo 2, before any money moves:

- `T = [t]·G` on the Orchard spend-auth base: the same `T` the adaptor signature is locked to.
- `c_i = m_i + Poseidon(t, i+1)`: the ciphertext is the plaintext under a keystream from `t`.
- `Poseidon(m) = h`: the plaintext matches a content hash the payer already agreed on.

Public inputs: `[T.x, T.y, h, c_0..c_{N-1}]`. The payer runs `verify_offer` against the `T` from the session, then pre-signs. When the signature lands, it runs `extract_t` and `open` to decrypt.

- Payload: up to 1,953 bytes per proof (64 chunks of 31 bytes, chunk 0 = length).
- Proof: about 4.3 KB. Proving takes about 3.3 s on a laptop-class CPU, with no trusted setup (IPA).
- `t` is sampled below the Pallas base modulus (`sealed::new_secret`) so it works both as a scalar and as a field element.
- Limit: this proves the content matches `h`. The payer still has to know which `h` it wants, e.g. a hash published or attested out of band.

```bash
cargo run --release --bin lintel-cli -- sealed-demo "your secret payload"
# {"offer_verified":true,"paid_ok":true,"decrypted_ok":true,"proof_bytes":4352,...}
```

## Reproduce

```bash
cd engine
cargo test --lib protocol::tests
cargo test --lib disclosure::tests
cargo test --release --lib sealed::tests
cargo run --bin lintel-cli -- demo
```

## What is verified

- Nonce is generated inside the seller and consumed on use.
- Buyer computes its partial from `R_a` alone.
- `verify_presig` recomputes `R` and checks `vk_hex` against `rk`.
- Seller proves knowledge of `sk_a`; proofs use a separate domain.
- Completed signature verifies under `rk`.
- Seller extracts `t` without `sk_b`.
- MinValue circuit: `C = Poseidon(value, blind, txid_lo, txid_hi)` computed in-circuit; public inputs `[min, txid_lo, txid_hi, C]`; running sum starts from a fixed constant 0, 64-bit range check on `value - min`.
- Real Halo 2 prove/verify (IPA over Pasta) in `disclosure::prove`.
- Sealed goods: wrong content hash, tampered ciphertext, and a key not bound to `T` all fail; the end-to-end test pays, extracts `t`, and decrypts.
- Peer-supplied hex is parsed with `parse_scalar`/`parse_point`; malformed input returns an error, never panics.

## Not yet done

- reddsa SpendAuth cross-check.
- Testnet transaction with this flow.
