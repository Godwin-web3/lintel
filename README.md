# Lintel

Conditional settlement on Zcash using two-party adaptor signatures.

## Flow

`R = R_a + R_b + T`, `rk = vk_a + vk_b + α·G`, `c = H(R ‖ rk ‖ sighash)`.

1. Both parties agree on `R` and `rk`.
2. Buyer sends `s_b = r_b + c·sk_b` and a knowledge proof.
3. Seller checks `s_b·G == R_b + c·vk_b` and the proof, then sends `s_a = r_a + c·(sk_a + α)`.
4. Buyer completes `s = s_a + s_b + t`.
5. Seller extracts `t = s − s_a − s_b` without learning `sk_b`.

## Reproduce

```bash
cd engine
cargo test --lib protocol::tests
```

Expected: extraction and rk verification pass, rogue proof is rejected, session binding holds.

## What is verified

- Buyer partial is `s_b = r_b + c·sk_b`; seller rejects an invalid partial.
- Completed signature verifies under `rk`.
- Seller extracts `t` without `sk_b`.
- Knowledge proofs bind both keys and a session ID.

## Not yet done

- Poseidon-bound disclosure circuit.
- reddsa SpendAuth cross-check.
- Testnet transaction with this extraction flow.
- Refund path and `cmx` binding.
