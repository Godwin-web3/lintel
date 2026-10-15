# Lintel

Conditional settlement on Zcash.

A two-party payment where the seller creates an adaptor pre-signature and the buyer completes it only after the condition is met. An adversary without the secret cannot spend. Selective disclosure lets a party prove one fact without revealing the note.

## Status

Testnet. Three adaptor-enabled PCZT spends have been mined. A Halo 2 selective disclosure circuit (MinValue and InvoiceHash, bound to a txid) passes MockProver.

## What is here

- `engine/` — Rust crate with the two-role adaptor flow, CLI, and selective disclosure circuit
- `web/` — website and local server that wraps the CLI
- `docs/` — settlement spec and package notes

## Evidence

| Description | txid | Height |
|-------------|------|--------|
| Single-key adaptor | `77b82ea5167c617a4533c52a8263435a95e767de7e695f9953db00d524983427` | 4,503,051 |
| Two-party adaptor | `f61ce7bbb0f2a3a1ba11eb28d068bd1f6bda09428f67be8baf2ac7dcd88a85bd` | 4,503,072 |
| Two-role settlement | `51c6daaf0aba583cfcfed9a928a53d22e5f5f7c3f97db71935a0b6d4387d02b8` | 4,504,858 |

## Not claimed

Fully trustless under every adversarial condition. An exchange between two independently funded parties. A production range-check lookup or full Orchard note path inside the circuit. Mainnet.

## Known dependency

The working PCZT path required a local patch to the NU7 branch ID (`0x77190ad9`) because the published `zcash_protocol` crate still uses a placeholder.
