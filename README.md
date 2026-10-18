# Lintel

Conditional settlement on Zcash using two-party adaptor signatures.

## Flow

1. Buyer sends a nonce `R_b`, a partial signature `s_b`, and `T = t·G`.
2. Buyer supplies a knowledge proof that binds both keys and a session ID.
3. Seller verifies the proof, then pre-signs. Alpha is folded into the seller's share so the signature verifies under `rk`.
4. Buyer completes: `s = s_a + s_b + t`.
5. Seller extracts `t = s − s_a − s_b` without learning `sk_b`.

## Reproduce

```bash
cd engine
cargo test --lib protocol::tests
cargo test --lib disclosure::tests
```

Expected: extraction test passes, session-binding test passes, rogue-proof test fails, disclosure test passes.

To build the inject binary (requires the NU7 patch):

```bash
cargo build --bin lintel-inject --features inject
```

## What is verified

- Seller extracts `t` without `sk_b`.
- Knowledge proofs bind both keys and a session ID; a proof from another session or key is rejected.
- `pre_sign` rejects a missing or invalid proof.
- Alpha is folded so the challenge uses `rk`.
- MinValue circuit opens a public commitment `C = value + blinding` and constrains the bit sum of the difference.

## Not yet on-chain

- The PCZT injection binary is behind the `inject` feature. It needs `orchard`, `pczt`, and a local NU7 branch-ID patch.
- No testnet transaction has yet been produced with this extraction flow.
- The disclosure circuit is not yet bound to a note commitment `cmx`.

## Testnet evidence

See `docs/evidence.md` for earlier adaptor spends. Those used a previous harness.
