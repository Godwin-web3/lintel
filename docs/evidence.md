# Lintel — Testnet Evidence

## Mined transactions

| Description | txid | Height |
|-------------|------|--------|
| Single-key adaptor PCZT | `77b82ea5167c617a4533c52a8263435a95e767de7e695f9953db00d524983427` | 4,503,051 |
| Two-party additive adaptor PCZT | `f61ce7bbb0f2a3a1ba11eb28d068bd1f6bda09428f67be8baf2ac7dcd88a85bd` | 4,503,072 |
| Two-role (seller/buyer) settlement | `51c6daaf0aba583cfcfed9a928a53d22e5f5f7c3f97db71935a0b6d4387d02b8` | 4,504,858 |
| Full create→complete→inject→broadcast | `97fb254c6d92659f7dfdd730f8bfe57f2c1447ef6ad9ff5fe5725d41fc3adbf8` | 4,505,478 |

All four are mined. The fourth was produced by feeding the real per-action sighash into the CLI, injecting the completed signature via `apply_ironwood_signature`, and broadcasting.

## PCZT injection

See `engine/src/bin/lintel-inject.rs`. It:
1. Reads a proved PCZT
2. Gets the real shielded sighash via `Signer::shielded_sighash()`
3. Calls the CLI with that sighash and the per-action alpha
4. Injects the completed signature with `apply_ironwood_signature`
