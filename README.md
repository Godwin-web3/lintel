# Lintel

Conditional settlement on Zcash using two-party adaptor signatures.

## Flow

`R = R_a + R_b + T`, `rk = vk_a + vk_b + α·G`, `c = H(R ‖ rk ‖ sighash)`.

1. Seller generates a single-use nonce and publishes only `R_a`.
2. Buyer computes `s_b = r_b + c·sk_b` from `R_a` (never sees `r_a`).
3. Seller checks the buyer's knowledge proof and `s_b·G == R_b + c·vk_b`, then sends `s_a`.
4. Buyer checks `s_a·G == R_a + c·(vk_a + α·G)` before completing.
5. Seller extracts `t = s − s_a − s_b` without learning `sk_b`.

Proofs of knowledge use a separate personalization domain (`Lintel_PoK_v1`).

## Reproduce

```bash
cd engine
cargo test --lib protocol::tests
cargo test --lib disclosure::tests
cargo run --bin lintel-cli -- demo
```

Expected: protocol tests pass, disclosure tests pass (including value-below-min failure), demo prints all three `true`.

## What is verified

- Nonce is generated inside the seller and consumed on use.
- Buyer computes its partial from `R_a` alone.
- Buyer verifies `s_a` before completing.
- Seller proves knowledge of `sk_a`; proofs use a separate domain.
- Completed signature verifies under `rk`.
- Seller extracts `t` without `sk_b`.
- MinValue circuit: each running-sum row is gated (`r_cur = 2·r_prev + bit`), so a value below `min` cannot pass.

## Not yet done

- Poseidon commitment binding the value and txid.
- reddsa SpendAuth cross-check.
- Testnet transaction with this flow.
