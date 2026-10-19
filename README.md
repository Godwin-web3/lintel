# Lintel

Conditional settlement on Zcash using two-party adaptor signatures.

## Flow

`R = R_a + R_b + T`, `rk = vk_a + vk_b + α·G`, `c = H(R ‖ rk ‖ sighash)`.

1. Seller generates a single-use nonce and publishes only `R_a`.
2. Buyer computes `s_b = r_b + c·sk_b` from `R_a` (never sees `r_a`).
3. Seller checks the buyer's knowledge proof and `s_b·G == R_b + c·vk_b`, then sends `s_a`.
4. Buyer recomputes `R = R_a + R_b + T`, checks `vk_hex` against `rk`, and verifies `s_a` before completing.
5. Seller extracts `t = s − s_a − s_b` without learning `sk_b`.

## Reproduce

```bash
cd engine
cargo test --lib protocol::tests
cargo test --lib disclosure::tests
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
- Peer-supplied hex is parsed with `parse_scalar`/`parse_point`; malformed input returns an error, never panics.

## Not yet done

- reddsa SpendAuth cross-check.
- Testnet transaction with this flow.
