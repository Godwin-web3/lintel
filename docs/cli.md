# CLI reference

The engine ships four binaries. Build from `engine/` with a recent stable Rust toolchain; built binaries land in `../target/release` (or `$CARGO_TARGET_DIR/release`).

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
| `verify-witness --txid X` | Diagnostic, no keys: rebuild the witness of every Ironwood output of a mined tx and check it against the chain's tree root |

`engine/examples/testnet_sale.rs` (`--features net`) runs the whole on-chain sale and refund. See [On-chain settlement](onchain.md).

## `lintel-agent` (seller agent)

Finishes your on-chain sales while the app is closed. Needs the `agent` feature:

```sh
cargo build --release --features agent --bin lintel-agent
```

| Command | Purpose |
| --- | --- |
| `import <handoff.json> [--dir DIR] [--force]` | Check a handoff file against the relay (`T` and the merchant key must match the listing) and store it |
| `run [--dir DIR] [--interval SECS] [--once]` | Advance every stored listing until stopped (default every 10 s, minimum 2) |
| `status [--dir DIR]` | Show each stored listing's stage |
| `remove <listing-id> [--dir DIR]` | Stop handling a listing and delete its secrets here |

The handoff file comes from **Hand off to agent** on a single-copy on-chain listing in the app's **My sales**. For each listing the agent checks the buyer's key proof, binds the escrow key, co-signs the time-locked refund, builds the settlement once the funding is mined, then signs, proves and broadcasts it, re-running every check the seller's app makes. Payouts go to the address in the handoff file (your app wallet); the agent holds no wallet spending key.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LINTEL_AGENT_DIR` | `~/.lintel-agent` | Where imported listings are stored (`--dir` overrides) |
| `LINTEL_LWD` | `https://testnet.zec.rocks:443` | lightwalletd endpoint; the agent reads chain data directly, not through the relay |

The handoff file and the agent directory hold secrets: anyone with them can complete the sale. Keep them on a machine you control. To take a sale back into the browser, stop the agent for it first (`lintel-agent remove <id>`), then choose **Take back** in **My sales**. A live run is recorded in [On-chain settlement](onchain.md#seller-agent-browser-closed).

## `lintel-inject` (legacy)

Behind the `inject` feature. An early tool for injecting Lintel signatures into PCZTs; superseded by `lintel-chain` and the browser flow.
