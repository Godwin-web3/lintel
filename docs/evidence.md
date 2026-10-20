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

## Two-party escrow on Ironwood (branch `onchain-settlement`)

| Description | txid | Height |
|-------------|------|--------|
| Funding: payer → joint escrow (`ak = vk_payer + vk_merchant`) | `da340dee5bb4a8ec11872d184c884b38aabfba3060a68e76d17df32628d6cf91` | 4,521,270 |
| Settlement: escrow → merchant, adaptor-signed over the real sighash/alpha; payer extracted `t` from this tx | `8b4ada0992642b2a71649e08c8de8d0b00cdf90a46a2794d4e09ca7999a3c0a8` | 4,521,277 |
| Funding (second sale) | `f11c111d89e870b69ade0478f7331f0e8131bac7c596846a8327832a16a235e4` | 4,521,282 |
| Refund: pre-signed before funding, broadcast by the payer alone | `633ac619a5305b961d0d3187f26cc61f6b9211a49b3bb787a30d044aee6a3f03` | 4,521,289 |

These are not self-spends: the escrow note belongs to the joint key, and neither party could spend it alone.
Public records: `docs/testnet/evidence-*.json`. Details: `docs/onchain.md`.
