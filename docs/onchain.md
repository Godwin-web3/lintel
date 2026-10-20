# On-chain settlement on Zcash testnet

Status: **working end to end on the public testnet**, driven from the CLI.
The browser has the bindings for it but does not yet run the on-chain flow by itself.

Network facts this is built against: testnet is on NU7, consensus branch `0x77190ad9`
(activated at height 4,465,026). Shielded value lives in the **Ironwood** pool (NU6.3+), and
transactions are **v6**. Orchard-pool cross-address transfers are disabled since NU6.3, so the
escrow uses the Ironwood pool. The Ironwood pool uses the same key structure and RedPallas
spend authorization as Orchard. Crates: `orchard 0.16`, `pczt 0.10.0-pre.2`,
`zcash_primitives 0.31.0-pre.2`, `zcash_protocol 0.11.0-pre.1` (NU7 branch id built in, so no
local patch is needed any more).

## Live evidence (testnet)

| What | txid | Height |
| --- | --- | --- |
| Faucet → payer wallet (Ironwood note) | `924bfddf5db48c3df04040025e1e2589d23e9b675d916bf1a7b6d7165aecca70` | 4,521,250 |
| **Sale 1: funding** (payer → joint escrow, 0.03 TAZ) | `da340dee5bb4a8ec11872d184c884b38aabfba3060a68e76d17df32628d6cf91` | 4,521,270 |
| **Sale 1: settlement** (escrow → merchant 0.02 + change to payer, adaptor-signed) | `8b4ada0992642b2a71649e08c8de8d0b00cdf90a46a2794d4e09ca7999a3c0a8` | 4,521,277 |
| **Sale 2: funding** | `f11c111d89e870b69ade0478f7331f0e8131bac7c596846a8327832a16a235e4` | 4,521,282 |
| **Sale 2: refund** (pre-signed before funding, broadcast by payer alone) | `633ac619a5305b961d0d3187f26cc61f6b9211a49b3bb787a30d044aee6a3f03` | 4,521,289 |

Sale 1: the payer read the settlement transaction from lightwalletd, found the spend
authorization signature, recovered `t`, and decrypted the sealed payload. The merchant received
2,000,000 zats. Sale 2: the merchant was treated as gone after funding, and the payer recovered
2,990,000 of the 3,000,000 zats (the rest is the ZIP 317 fee) using only the refund it had signed
before funding. The full public records are in [`testnet/evidence-settle.json`](testnet/evidence-settle.json)
and [`testnet/evidence-refund.json`](testnet/evidence-refund.json).

Reproduce (needs a funded testnet wallet; the Valar faucet's `POST /api/claim` works):

```bash
cd engine
cargo build --release --features net --bin lintel-chain --example testnet_sale
B=../target/release   # or $CARGO_TARGET_DIR/release
$B/lintel-chain wallet --out demo/payer-wallet.json            # prints a utest1… address; fund it
$B/lintel-chain scan --txid <faucet txid> --wallet demo/payer-wallet.json --out demo/payer-source-note.json
$B/examples/testnet_sale demo settle    # or: refund
```

`testnet_sale` is a demo harness. It runs both parties in one process so one command
reproduces a sale. They still exchange only public messages, and no share, `t` or plaintext is
printed. In the product, each side signs in its own browser through lintel-wasm.

## Item by item

### 1. Real testnet settlement: CLI fallback, not WebZjs

I chose the CLI path. I did not attempt WebZjs. The testnet now needs the pre-release
librustzcash line (Ironwood, v6, NU7 branch id), and porting a browser wallet onto it was not
feasible in the time left. What exists instead:

- `engine/src/chain.rs` (feature `chain`) does the following:
  - computes the joint key and escrow address;
  - finds escrow notes in raw transactions by trial-decrypting with the joint IVK;
  - builds v6 PCZTs with `DeferredPcztBuilder`;
  - checks a PCZT against the agreed terms;
  - applies the signature, builds the witness, proves and extracts, and finds the signature in a transaction.
- `engine/src/lwd.rs` (feature `net`) is a minimal lightwalletd gRPC client. It supports
  `GetLatestBlock`, `GetTransaction`, `GetTreeState`, `GetBlockRange` (Ironwood pool) and
  `SendTransaction`.
- `engine/src/bin/lintel-chain.rs` runs each chain step as a separate command that prints JSON.
  The commands are `height`, `wallet`, `address`, `joint`, `scan`, `build`, `check`, `fund`,
  `apply`, `finalize`, `broadcast`, `fetch-sig` and `verify-witness`. It touches only public data
  and the caller's own single-signature wallet file.
- **Witness construction is checked against live data.** `lintel-chain verify-witness --txid …`
  builds witnesses from `GetTreeState(h-1)` plus the compact block and compares them with the
  node's own root at height `h`. `finalize` runs the same cross-check before every proof.

### 2. Joint adaptor key = the note's `ak`

- `protocol::joint_ak(vk_payer, vk_merchant)` returns `ak = vk_payer + vk_merchant`. Orchard
  requires ỹ(ak) = 0. When the sum has ỹ = 1, **both parties negate their own share**
  (`negate_share`), which keeps `ak = vk_a + vk_b`. Each side decides this from the two public
  keys alone, so no extra round is needed. In wasm this is `bindJoint`; it is idempotent and
  survives `exportState`.
- `nk` and `rivk` are derived with `BLAKE2b-512("Lintel_JointFVK_", tag ‖ session ‖ contrib_payer ‖ contrib_merchant)`,
  reduced into the base and scalar fields. Each party contributes 32 random bytes.
- The joint FVK is `FullViewingKey::from_bytes(ak ‖ nk ‖ rivk)`. The escrow address is its
  external address 0, encoded as a testnet UA. `encode_ufvk` exports a UFVK so either side can
  watch the escrow in a normal view-only wallet.
- The test asserts that `fvk.to_bytes()[..32] == ak`. On chain, the escrow spend is accepted
  under `rk = ak + [alpha]G`.

Trust assumptions:

- **Spending.** Only `ak` authorizes a spend. A spend needs a RedPallas signature under
  `rk = ak + [alpha]G`, which requires `sk_a + sk_b`. Neither party can spend alone.
- **`nk` and `rivk`.** These only affect nullifiers and the address, which is a privacy matter.
  A party that picks them badly cannot move funds.
- **Rogue keys.** Each side must verify the other's proof of knowledge of its share *before the
  escrow is funded*. Otherwise a party could publish `vk = K − vk_peer` and own the escrow alone.
  - The payer checks the merchant's proof inside the refund signing session (`pre_sign`), which
    happens before funding.
  - The merchant checks the payer's proof with `verifyPayerKnowledge`, added in wasm and used in
    `testnet_sale`.
- **Privacy between the parties.** Both parties hold the joint FVK, so both see the escrow note
  and its spend details. That is inherent to a joint output.
- **Privacy from the relay.** The relay is not trusted with the FVK. If the contributions and
  verification keys are posted to the relay, its operator can derive the FVK too. That lets the
  operator see the escrow, but it cannot spend from it. To avoid this, exchange contributions out
  of band or encrypted. This is not done yet.

### 3. Real sighash and alpha

Nothing random is signed any more:

- `sighash` is `Signer::shielded_sighash()` of the agreed PCZT.
- `alpha` is the escrow action's `alpha` from that PCZT.
- `rk` is checked to equal the protocol's `vk_hex`.

Both parties run `chain::check_spend` (`lintel-chain check`) on the same PCZT bytes, and each
signs only what its own check returns. `check_spend` rejects the PCZT if any of these fail:

- No transparent, Sapling or Orchard-pool data.
- The expiry height and consensus branch are as agreed.
- The escrow note is spent exactly once, and its nullifier and `rk` derive from the joint FVK.
- Every other spend has value 0 (padding).
- Every `cv_net` and output `cmx` matches its stated values.
- The outputs pay exactly the agreed amount to the agreed address, with change only to the payer.
- The fee is the ZIP 317 fee.

`apply_ironwood_signature` then verifies the completed signature with **reddsa** before
accepting it. This closes the earlier "reddsa SpendAuth cross-check" gap. Finally, the PCZT
extractor fully verifies the proof and the spend-auth and binding signatures before a
transaction is written.

### 4. `t` comes from the chain, not the relay

- The merchant completes the signature, applies it to the PCZT, proves it and **broadcasts the
  transaction itself**. In the on-chain flow the relay only ever sees `settle_txid`.
- For v6, the txid excludes anchors, proofs and signatures. Both parties therefore know the
  settlement txid as soon as they check the PCZT (asserted in the test).
- The payer fetches the mined transaction through lightwalletd, or through the relay's
  `GET /chain/tx/:txid` proxy. It extracts the signature with `protocol::find_signature`, which
  locates the agreed nonce commitment `R` in the raw bytes and verifies `(R, s)` under the payer's
  own `rk` and sighash. It then computes `t = s − s_a − s_b`. wasm `Payer.unlockFromTx` does the
  same. Because the signature is verified, the source of the bytes does not need to be trusted.

### 5. Refund and timeout

**What is implemented:** a refund that is co-signed before the escrow is funded.

- v6 transactions commit to anchors and witnesses only in the authorizing data
  ([ZIP 374](https://zips.z.cash/zip-0374)). With `DeferredPcztBuilder`, the refund (escrow → payer)
  can therefore be signed as soon as the escrow note's contents are known. The payer knows them
  because it builds the funding transaction itself (`lintel-chain fund` builds, signs and proves
  without broadcasting).
- The refund session is the normal protocol with the merchant's adaptor secret fixed to zero
  (`refund_partial`, so `T` = identity). The payer completes it alone with `complete_refund`,
  which rejects a partial locked to a real `T`.
- Order of steps: build the funding tx → co-sign the refund (this also checks the merchant's
  proof of knowledge) → the payer stores the signed refund PCZT → broadcast funding. If the
  merchant disappears at any point after that, the payer installs the witness and broadcasts the
  refund (live: sale 2). The refund has no expiry.
- The settlement has an expiry height, which the signatures commit to. That expiry is the
  merchant's claim window.

**Not solved: a lower-bound timelock on the refund.** Zcash enforces `nLockTime` only when a
transparent input has `nSequence < 0xffffffff`. A shielded-only refund is therefore valid
immediately. The consequence: if the merchant broadcasts the claim (revealing `t` in the mempool)
and the payer gets the conflicting refund mined first, the payer gets both the goods and the
money. Nodes reject a second spend of the same nullifier from the mempool, so the payer would need
a miner's help. Still, this is a real gap in the protocol, not just a theoretical one.

Proposed v2 (not implemented):

- The refund also spends a small transparent UTXO owned by the payer, with
  `nSequence = 0xfffffffe` and `nLockTime = H_refund`.
- The settlement expiry `H_claim` is set below `H_refund` by a safety margin.
- The merchant's `check_spend` for the refund requires that lock time and the non-final
  sequence. Both are covered by the sighash, so the payer cannot remove them later.
- Cost: `DeferredPcztBuilder` takes no transparent inputs. The PCZT would need to be assembled
  from a deferred Ironwood bundle plus a transparent bundle, using the PCZT Combiner and Updater
  roles, or with a builder change upstream.
- Until then the merchant should broadcast the claim to several nodes at once and treat the
  refund race as the residual risk.

Other refund caveats:

- The refund is signed for the consensus branch that is current when it is built. A network
  upgrade before it is used would invalidate it, and it would have to be re-signed.
- The refund returns the note value minus the 10,000-zat fee.

## Manual flow with lintel-chain (two machines)

1. **Both:** exchange `vk`s, proofs of knowledge, and 32-byte contributions. Then run
   `lintel-chain joint --vk-payer … --vk-merchant … --session … --contrib-payer … --contrib-merchant … --out joint.json`
   and confirm both sides got the same `escrow_address`.
2. **Payer:**
   1. `scan` its wallet note.
   2. `fund --wallet w.json --note src.json --terms fund-terms.json --out fund.tx` (this does not broadcast).
   3. `scan --tx-file fund.tx --joint joint.json --out escrow.json`.
   4. `build --key joint.json --note escrow.json --terms refund-terms.json --out refund.pczt`.
3. **Both:** `check` the refund PCZT and sign it. The merchant calls `refundPartial`; the payer
   calls `refundSign`. **Payer:** `apply`, keep `refund.pczt`, then `broadcast --tx fund.tx`.
4. **Once funding is mined:** both re-`scan --txid` to get the escrow height.
5. **Merchant:** `build` the settlement PCZT and send it to the payer.
6. **Both:** `check` the settlement PCZT, then run the adaptor signing with the returned
   `sighash`/`alpha`.
7. **Merchant:** `apply --sig <completed>`, `finalize`, `broadcast`.
8. **Payer:** `fetch-sig --txid <settlement> --r … --rk … --sighash …`, or `unlockFromTx` in the
   browser.

## Tests

| Suite | Result | Command |
| --- | --- | --- |
| Engine lib | 20 passed (the original 17 plus 3 new protocol tests: joint key normalization, refund completion and locked-partial rejection, signature search in bytes) | `cargo test --release --lib` |
| Engine integration (`tests/settlement.rs`) | 1 passed, about 35 s (details below) | `cargo test --release --features chain --test settlement` |
| wasm | 3 passed (the 2 existing plus 1 new: joint binding, both proofs of knowledge, refund signing, unlock from transaction bytes) | `cargo test --release` in `wasm/` |
| Relay | 4 passed (the 2 existing plus on-chain fields and protobuf decoding) | `node --test` in `web/relay` |

The integration test covers the whole flow offline:

- builds, signs and proves a real v6 funding transaction to the joint address;
- finds the escrow note with the joint IVK;
- pre-signs the refund before funding;
- rejects tampered terms;
- shows a pre-signature without `t` is rejected by reddsa;
- builds and verifies the settlement, and its txid matches the one predicted before signing;
- recovers `t` from the serialized transaction and decrypts;
- checks that the refund is also a valid transaction on the same nullifier.

## Remaining gaps

- **Browser UI.** The browser does not yet run the on-chain flow end to end. The wasm bindings
  (`bindJoint`, `verifyPayerKnowledge`, `refundPartial`, `refundSign`, `unlockFromTx`), the
  worker operations, the relay's write-once `/sessions/:id/chain/:field` fields and the
  `/chain/tx/:txid` proxy are in place. The pages still run the off-chain demo flow with
  placeholder `sighash`/`alpha`, and proving and broadcasting need the CLI.
- **Refund timelock:** see item 5, v2.
- **Contributions over the relay** reveal the escrow FVK to the relay operator (privacy only).
- **One sale per listing**, and testnet only.
