# CLI reference

The engine ships three binaries. Build from `engine/` with a recent stable Rust toolchain.

## `lintel-cli`

```sh
cargo run --release --bin lintel-cli -- demo
cargo run --release --bin lintel-cli -- sealed-demo [payload]
```

- `demo` runs the two-party adaptor-signature flow off-chain (pre-sign, complete, extract `t`) and prints which checks passed as JSON.
- `sealed-demo` seals `payload` (or a sample) under a fresh `t`, proves the ciphertext, verifies it as the buyer would, settles the adaptor signature and decrypts.

## `lintel-chain` (Zcash testnet)

Needs the `net` feature: `cargo run --release --features net --bin lintel-chain -- <command>`.

| Command | Purpose |
| --- | --- |
| `height` | Current testnet tip |
| `wallet --out w.json` | New single-sig testnet wallet (secret, keep local) |
| `address --wallet w.json` | Its Unified Address |
| `joint --vk-payer H --vk-merchant H --session S --contrib-payer H32 --contrib-merchant H32 --out joint.json` | Derive the joint escrow key and address |
| `scan (--txid X \| --tx-file tx.hex) (--joint joint.json \| --wallet w.json) --out note.json` | Find a note you can spend |
| `build --key (joint.json\|w.json) --note note.json --terms terms.json --out spend.pczt` | Build an unsigned spend |
| `check --joint joint.json --note note.json --terms terms.json --pczt spend.pczt` | Check a PCZT matches the agreed terms |
| `fund --wallet w.json --note src.json --terms terms.json --out fund.tx` | Build, sign and prove a funding spend (does not broadcast) |
| `apply --pczt in.pczt --index I --sig H64 --out out.pczt` | Insert a spend-auth signature |
| `finalize --pczt in.pczt --note note.json --index I --out tx.hex` | Add the witness, prove and verify |
| `broadcast --tx tx.hex` | Broadcast |
| `fetch-sig --txid X --r H --rk H --sighash H` | Extract the completed spend-auth signature from a mined tx |

`engine/examples/testnet_sale.rs` (`--features net`) runs the whole on-chain sale and refund. See [On-chain settlement](onchain.md).

## `lintel-inject` (legacy)

Behind the `inject` feature. An early tool for injecting Lintel signatures into PCZTs; superseded by `lintel-chain` and the browser flow.
