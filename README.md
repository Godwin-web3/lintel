# Lintel

Conditional settlement on Zcash using two-party adaptor signatures.

## Roles

- **Seller** holds only `sk_a`. Creates an adaptor pre-signature given `T = t·G`.
- **Buyer** holds only `sk_b` and the secret `t`. Verifies the pre-signature, then completes it.
- `T` is the only value shared before completion. Neither party can spend alone.

## Reproduce (60 seconds)

```bash
cd engine
cargo test --lib protocol::tests
```

Expected: 2 tests pass (roundtrip + adversary cannot complete).

## What is verified

- Pre-signature verification: `s_a·G == R' − T + c·vk_a`
- Secret extraction: seller recovers `t` from the completed signature
- Adversary without `t` cannot produce a signature that extracts the correct secret
- Message signed is the transaction sighash

## Testnet evidence

See `docs/evidence.md`. Four adaptor-enabled spends have been accepted on Zcash testnet.

## Not claimed

Fully trustless under every adversarial condition. An exchange between two independently funded parties. A production range-check lookup. Mainnet.

## Known dependency

The PCZT broadcast path required a local patch to the NU7 branch ID (`0x77190ad9`).
