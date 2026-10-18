# Lintel

Conditional settlement on Zcash using two-party adaptor signatures.

## Roles

- **Seller** holds only `sk_a`. Receives `vk_b` and `T = t·G`, then creates a pre-signature.
- **Buyer** holds only `sk_b` and `t`. Verifies the pre-signature, then completes it.
- Joint verification key is `vk = vk_a + vk_b`. Both parties compute the challenge with this `vk`.

## Reproduce

```bash
cd engine
cargo test --lib protocol::tests
cargo run --bin lintel-cli -- demo
```

Expected: both tests pass; the demo prints `presig_ok:true` and `completed_ok:true`.

## What is verified

- Pre-signature checks under the joint key.
- Completed signature verifies under the joint key (`s·G == R' + c·vk`).
- Wrong `t` fails verification.
- `extract_t` recovers `t` when given `sk_b` (the buyer, or a party that learns it).

## What is not yet sound

- The seller alone cannot extract `t` without `sk_b`.
- No proof of knowledge on key shares (a buyer could choose `vk_b` to cancel `vk_a`).
- The Halo 2 circuit checks bits are boolean but does not yet constrain them to sum to `diff`. A value below `min` can still pass. The range is 32 bits. The invoice claim checks equality with a public value rather than a hash. The txid is a public input but is not cryptographically bound to the witness.
- The PCZT injection binary is not in the default build (it requires `orchard` and `pczt` crates and a local NU7 patch).

## Testnet evidence

See `docs/evidence.md`. Four adaptor-enabled spends have been mined on Zcash testnet. Those transactions used a separate harness; the code in this repo is the cleaned protocol and does not by itself reproduce the broadcasts.

## Known dependency

Broadcasting a PCZT required a local patch to the NU7 branch ID (`0x77190ad9`).
