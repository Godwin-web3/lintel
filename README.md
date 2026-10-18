# Lintel

Conditional settlement on Zcash using two-party adaptor signatures.

## Roles

- **Seller** holds only `sk_a`. Receives `vk_b` and `T = t·G`, then creates a pre-signature.
- **Buyer** holds only `sk_b` and `t`. Verifies the pre-signature, then completes it.
- Joint verification key is `vk = vk_a + vk_b`. Both parties compute the challenge with this `vk`.
- Each party can produce a Schnorr proof of knowledge of its scalar.

## Reproduce

```bash
cd engine
cargo test --lib protocol::tests
cargo test --lib disclosure::tests
cargo run --bin lintel-cli -- demo
```

Expected: protocol tests pass (including knowledge proofs), disclosure test passes, demo prints `presig_ok:true` and `completed_ok:true`.

## What is verified

- Pre-signature checks under the joint key.
- Completed signature verifies under the joint key (`s·G == R' + c·vk`).
- Wrong `t` fails verification.
- `extract_t` recovers `t` when given `sk_b`.
- Schnorr proof of knowledge: each party proves it knows its scalar; a proof for one key fails against another.
- MinValue circuit: `value = min + diff`, each bit of `diff` is boolean, and the weighted sum of the bits is copy-constrained equal to `diff`.

## What is not yet sound

- The seller alone cannot extract `t` without `sk_b`.
- The circuit range is 32 bits. There is no invoice-hash claim. The txid is a public input but is not bound to an on-chain note.
- The PCZT injection binary is not in the default build.

## Testnet evidence

See `docs/evidence.md`. Four adaptor-enabled spends have been mined on Zcash testnet.

## Known dependency

Broadcasting a PCZT required a local patch to the NU7 branch ID (`0x77190ad9`).
