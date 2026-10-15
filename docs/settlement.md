# Lintel — Minimal Two-Party Conditional Settlement

## Participants
- **Seller (A)**: holds partial key `sk_a`. Creates the adaptor pre-signature.
- **Buyer (B)**: holds partial key `sk_b`. Completes the signature only after the condition is met.
- Combined key: `sk = sk_a + sk_b`, verification key `vk = [sk]·G`.

## Transaction lifecycle
1. Parties agree on the payment (amount, recipient, condition).
2. Seller produces an adaptor pre-signature on the combined key. The pre-signature is incomplete; the secret `t` (or its release) is the condition.
3. Buyer verifies the pre-signature structure.
4. Condition is satisfied (e.g. buyer reveals `t`, or an external event releases it).
5. Buyer completes the signature: `s = s_a + c·sk_b + t`.
6. The completed signature is injected into a PCZT and broadcast.
7. Either party can abort before step 5 by refusing to cooperate. After step 5 the transaction is valid on-chain.

## Abort conditions
- Seller refuses to produce a pre-signature → no transaction.
- Buyer refuses to complete → no transaction (seller’s pre-signature is useless alone).
- After completion, the transaction is standard and can be broadcast by either party.

## What the adaptor secret binds
The spend is valid if and only if the party that knows `t` completes the signature. An adversary without `t` cannot produce a signature that verifies under the combined verification key.

## Privacy claims (current scope)
- The on-chain transaction reveals only what any shielded Zcash transaction reveals (nullifiers, value commitments, ciphertext).
- The adaptor secret `t` is not published on-chain.
- Selective disclosure (MinValue / InvoiceHash) is implemented as a Halo 2 circuit and passes MockProver, bound to a txid.

## Testnet evidence
- Single-key adaptor PCZT: `77b82ea5167c617a4533c52a8263435a95e767de7e695f9953db00d524983427` (height 4,503,051)
- Two-party adaptor PCZT: `f61ce7bbb0f2a3a1ba11eb28d068bd1f6bda09428f67be8baf2ac7dcd88a85bd` (height 4,503,072)
- Two-role settlement: `51c6daaf0aba583cfcfed9a928a53d22e5f5f7c3f97db71935a0b6d4387d02b8` (height 4,504,858)

All are self-spends. They demonstrate that the completed adaptor signature is accepted by the network.

## Known dependency
The published `zcash_protocol` crate still uses a placeholder for the NU7 branch ID. The working path required a local patch to ZIP-259 id `0x77190ad9` (testnet activation 4,465,026) and the `nu7` unstable cfg.
