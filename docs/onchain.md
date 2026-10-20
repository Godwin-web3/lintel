# On-chain settlement on Zcash testnet

Status: **working end to end on the public testnet**, from the CLI and, for single-copy
(v1) listings, from the browser app (two browsers + relay, no CLI). Multi-copy presale
listings still settle off-chain. Limits of the browser flow are listed under
[Browser flow](#browser-flow-single-copy-listings) and [Remaining gaps](#remaining-gaps).

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
| **v2 sale 3: funding** (escrow 0.03 TAZ + payer lock UTXO 20,000 zats at vout 0) | `bf537d04a54f56ea4d2ff3a46e8e7bacf0a22443f016a8b539577e18144044e4` | 4,522,317 |
| v2 sale 3: time-locked refund broadcast early (the race attempt) | `2fb232bb424df6b3ece2addfa65750f3049c488c4600d56d44a5f6d2e5d99bd0`, **rejected**: "transaction is locked until after block height 4522354" | (tip 4,522,317) |
| **v2 sale 3: settlement** (expiry 4,522,354; merchant 0.02 TAZ; payer recovered `t` and decrypted) | `5dddb2db834dec47b4723e6e48bef94466b3839b7e337b0bb57cebb25ba22b5d` | 4,522,319 |
| **v2 sale 4: funding** | `78cf54eea301d14aa4998da5881e4f6f85ed7cab126b87e5a05efa733ebc16a2` | 4,522,324 |
| v2 sale 4: refund broadcast before the lock | `e78f088e5bae544378439cf8e665fca72abe1f0f1157feaf0167acf1502963b8`, **rejected**: "transaction is locked until after block height 4522333" | (tip 4,522,325) |
| **v2 sale 4: same refund after the lock** (2,985,000 zats + 20,000-zat lock coin back) | `e78f088e5bae544378439cf8e665fca72abe1f0f1157feaf0167acf1502963b8` | 4,522,335 |

Sale 1: the payer read the settlement transaction from lightwalletd, found the spend
authorization signature, recovered `t`, and decrypted the sealed payload. The merchant received
2,000,000 zats. Sale 2: the merchant was treated as gone after funding, and the payer recovered
2,990,000 of the 3,000,000 zats (the rest is the ZIP 317 fee) using only the refund it had signed
before funding. Sales 3 and 4 use the v2 time-locked refund (item 5). In both, the testnet
node rejected the pre-signed refund before its lock height with a consensus error. In sale 3 the
settlement then went through. In sale 4 the identical refund bytes were accepted and mined once
the chain passed the lock height. Records: [`testnet/evidence-v2-settle.json`](testnet/evidence-v2-settle.json),
[`testnet/evidence-v2-refund.json`](testnet/evidence-v2-refund.json). The v1 records are in [`testnet/evidence-settle.json`](testnet/evidence-settle.json)
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

## Browser flow (single-copy listings)

A seller ticks "Settle on Zcash testnet" when listing. A buyer with a funded device wallet
(Wallet page: create or import a key, then scan a txid that paid it) clicks "Buy on-chain".
Each browser runs its own half with the on-chain engine (`wasm/` with feature `chain`,
loaded as `src/pkg-chain` in a worker); they talk only through the relay's write-once
session fields, and chain data goes through the relay's lightwalletd proxy
(`/chain/height`, `/chain/tree/:h`, `/chain/cmxs/:h`, `/chain/tx/:txid`, `/chain/broadcast`).
Order: joint key → buyer builds funding + time-locked refund → seller co-signs the refund →
buyer broadcasts funding → seller builds the settlement → adaptor signing → seller proves and
broadcasts the settlement → buyer reads the mined settlement, extracts `t`, decrypts.
Proving and full verification run in the browser.

**Live run (2026-10-20, Zcash testnet, both sides driven through the UI in headless Chromium,
`web/app/scripts/onchain-live.mjs`, local relay proxying the public testnet lightwalletd):**

| What | txid | Height |
| --- | --- | --- |
| Funding (buyer device wallet → joint escrow, price 0.02 TAZ, + 20,000-zat lock coin) | `75053762c15aea7b27fad758928fc3009ca86d5ee3a10e35b17162914c302534` | 4,522,583 |
| Settlement (seller browser, adaptor-signed; expiry 4,522,639) | `c51697ebe0767395dee5fc54f246eccf53dc2e071f5690808ec77776939b2b67` | 4,522,588 |
| Earlier attempt: funding (mined, never settled) | `90446dccc95818de8808046167985311e0a6715c3580fa0de9fd24a41f8c9842` | 4,522,575 |
| Earlier attempt: pre-signed time-locked refund (lock 4,522,631) | `992163c4a20b3cc2e363b3720aeac8f25162c81bc795736d285b0b1bd3e43392` | 4,522,635 |

The buyer's browser fetched the mined settlement, recovered `t` from its spend-auth
signature, and the decrypted payload matched the sealed secret (`decrypted_matches: true`).
The relay never held a completed signature (`relay_saw_signature: false`). Record:
[`testnet/evidence-browser-settle.json`](testnet/evidence-browser-settle.json).

An earlier browser attempt the same day (listing `XpOyPOgiqhJW`) **did** get its funding
mined (`90446dccc95818de8808046167985311e0a6715c3580fa0de9fd24a41f8c9842`, height 4,522,575),
but the app reported the broadcast as rejected: testnet lightwalletd returns the txid
JSON-quoted on success and the relay did not accept that form. Fixed in the relay (quoted txid =
accepted) and in the app (on a rejection, a txid the node already knows counts as broadcast).
That sale never settled; its escrow is recovered with the pre-signed time-locked refund via
`web/app/scripts/refund-from-state.mjs` after its lock: refund `992163c4a20b3cc2e363b3720aeac8f25162c81bc795736d285b0b1bd3e43392` mined at height 4,522,635 (nLockTime 4,522,631). Record: [`testnet/evidence-browser-refund.json`](testnet/evidence-browser-refund.json).

Browser-flow limits (as of this branch):

- **The seller must be online when a buyer starts.** The refund is co-signed by the seller's
  open app *before* the buyer funds; with the seller offline the buyer waits and nothing is
  funded. The seller must also stay online to settle before the settlement expiry, or the buyer
  takes the refund after it. There is no seller agent for on-chain sales.
- **Presale (multi-copy, v2) listings are not wired on-chain.** They still settle off-chain.
- **The device wallet is minimal.** It only knows notes you scan in by txid; it marks a note
  spent only when this device funds an escrow with it. It does not scan the chain for spends
  made elsewhere (e.g. the same key imported on two devices), and it does not add change,
  refund or payout notes automatically — scan their txids. Funding needs one note that covers
  escrow + lock coin + fee.
- **Recovery is local.** The signed refund and the wallet key live only in that browser's
  localStorage. Clearing it before broadcasting the refund loses the escrow (testnet funds).
- **Production build unverified.** `web/app/build.sh` builds the on-chain engine with
  `wasm-pack --features chain`; `secp256k1-sys` needs a clang that targets wasm32. The script
  tries to install clang; if the build fails it ships a stub and the on-chain panels say the
  engine is unavailable. A Vercel build with the on-chain engine has not been verified.

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

**The refund race and the v2 time lock (implemented).**

The problem in v1: Zcash enforces `nLockTime` only through transparent inputs. A transaction
is final if `nLockTime == 0`, or `nLockTime < height`, or every transparent input has
`nSequence == 0xffffffff` (zcashd `IsFinalTx`). A shielded-only refund has no inputs that can
make it non-final, so it was valid at once. A payer who saw the settlement in the mempool could
read `t` from it and race the conflicting refund. If the refund was mined first, the payer got
both the goods and the money.

v2 closes this at the consensus layer:

- The funding transaction also pays a small P2PKH output (`LOCK_UTXO_VALUE` = 20,000 zats) to a
  transparent address the payer owns. Its outpoint is `funding_txid:0`. The v6 txid is known
  before broadcast, so the refund can reference that coin before funding goes out.
- The refund spends the escrow note **and** that coin, with `nSequence = 0xfffffffe`
  (`LOCK_SEQUENCE`, non-final) and `nLockTime = H_lock`. The coin goes back to the same
  address unchanged. Consensus rejects the refund in any block at height `≤ H_lock`.
- The settlement keeps its expiry height `E` (the claim window). It cannot be mined after `E`.
  The merchant co-signs the refund only if `H_lock ≥ E` (`chain::check_refund_window`). At no
  height are both the settlement and the refund valid. The claim window is therefore fixed
  before funding: `E` is agreed when the refund is signed.
- The joint spend-authorization signature signs the ZIP 244 shielded sighash. That sighash
  commits to `nLockTime`, the transparent prevouts, the sequences and the outputs, so the payer
  cannot strip or loosen the lock after the merchant has signed. The test recomputes the sighash
  with the lock time zeroed and with the transparent bundle removed, and both differ from the
  signed one.
- `check_spend` (which both parties run) checks that the transparent side matches the terms
  exactly:
  - one input, spending the agreed outpoint;
  - that input has sequence `0xfffffffe`, the agreed value and P2PKH script;
  - the effective lock time equals `H_lock`;
  - the PCZT's fallback lock time equals `H_lock` (the spend finalizer clears the per-input
    lock fields, after which the extractor falls back to the global value);
  - the transparent outputs are exactly those agreed;
  - the fee is the ZIP 317 fee for the shape: 15,000 zats with the lock, since one transparent
    input and output add one logical action.

  It refuses any `refund` without a lock. Settlements must have no transparent data and a lock
  time of 0.
- PCZT assembly: `DeferredPcztBuilder` takes no transparent inputs, so `build_spend` builds the
  Ironwood bundle with deferred anchors and attaches a hand-built transparent PCZT bundle
  (`zcash_transparent::pczt::{Input, Output}::parse`) to the `PcztParts` before the Creator
  runs. A fixed-amount fee rule tells the deferred builder exactly what the Ironwood bundle must
  release: fee + transparent outputs − transparent inputs. The payer signs its own lock input
  with `chain::sign_lock_input` at any time before broadcast.

Who is exposed to what now:

- **Payer.** If the merchant disappears, the payer waits until height `H_lock + 1` and
  broadcasts the refund. It gets back the escrow minus the 15,000-zat fee, plus the lock coin.
  If the payer spends the lock coin elsewhere, its own refund becomes invalid for good. That is
  self-harm only.
- **Merchant.** It must get the settlement mined by `E`. If it broadcasts so late that the
  settlement expires unmined, `t` has still leaked through the mempool, and the payer can take
  the refund after `H_lock`. Mitigation: broadcast early. The demo refuses to build the
  settlement within 10 blocks of `E`. Pick `E` with a comfortable margin.
- **Reorgs.** A reorg that removes a settlement mined close to `E` could leave it expired on
  the new chain. Mining early makes this negligible on mainnet-like finality.

Alternative considered: ZIP 203 `nExpiryHeight` gives only an upper bound. The settlement
already uses it for the claim window, but no shielded-only field gives a lower bound. So a
transparent input with a non-final sequence is the only consensus-enforced lower bound
available, short of a protocol change.

Other refund caveats:

- The refund is signed for the consensus branch that is current when it is built. A network
  upgrade before it is used would invalidate it, and it would have to be re-signed.
- The refund returns the note value minus the 15,000-zat fee, plus the 20,000-zat lock coin
  unchanged. The funding transaction also costs 15,000 zats, because its transparent lock
  output adds a logical action.
- The lock coin is transparent, so it links the funding transaction and the refund to the
  payer's t-address on chain. Use a fresh t-address per sale.

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

| Suite | Result (2026-10-20, branch `wire-onchain`) | Command |
| --- | --- | --- |
| Engine, feature `chain` | lib 28 passed; `tests/settlement.rs` 1 passed (~22 s) | `cargo test --release --features chain` in `engine/` |
| Engine, feature `net` (adds the lightwalletd client) | lib 28 passed; settlement 1 passed | `cargo test --release --features net` in `engine/` |
| wasm | 4 passed | `cargo test --release` in `wasm/` |
| wasm, feature `chain` | 5 passed (adds `chain::tests::browser_settlement_and_time_locked_refund_offline`: funding, v2 time-locked refund co-signed before funding, adaptor-signed settlement, proving + verification, `t` recovered from the raw settlement, all through the browser bindings) | `cargo test --release --features chain` in `wasm/` |
| Relay | 13 passed (incl. chain proxy: height/tree/cmxs/broadcast, JSON-quoted txid accepted, node error = rejected; chain-mode sessions) | `node --test` in `web/relay` |
| Live, browser | 1 sale settled on testnet (table above) | `node scripts/onchain-live.mjs` in `web/app` |

The integration test covers the whole flow offline:

- builds, signs and proves a real v6 funding transaction to the joint address;
- finds the escrow note with the joint IVK;
- pre-signs the refund before funding;
- rejects tampered terms;
- shows a pre-signature without `t` is rejected by reddsa;
- builds and verifies the settlement, and its txid matches the one predicted before signing;
- recovers `t` from the serialized transaction and decrypts;
- checks that the refund is also a valid transaction on the same nullifier;
- **refund time lock (v2):**
  - a v1 shielded-only refund is final at every height and is refused by `check_spend`;
  - the v2 refund has `nLockTime = LOCK` and its lock input has sequence `0xfffffffe`;
  - under the consensus finality rule (`chain::is_final`, zcashd `IsFinalTx`) the refund is
    invalid at the build height and at `LOCK`, and valid at `LOCK + 1`;
  - the settlement (expiry `LOCK`) and the refund are never both valid at any height;
  - removing the lock time or the lock input changes the sighash;
  - a PCZT with a lower lock height is refused against the agreed terms, and a refund window
    that starts before the settlement expiry is refused.

## Remaining gaps

- **Browser UI.** Single-copy listings run on-chain in the browser (see
  [Browser flow](#browser-flow-single-copy-listings)), with its limits: seller must be online
  to co-sign the refund before funding, presale listings not wired, minimal wallet that does
  not track spends made elsewhere, refund kept only in localStorage, and the production
  (Vercel) build of the on-chain engine unverified (needs clang; stub fallback).
- **Refund timelock:** implemented (item 5, v2). The `lintel-chain` CLI subcommands accept
  the new `lock`/`t_out` terms fields through JSON. There is no CLI subcommand yet to create
  or sign a transparent key; the `testnet_sale` harness does it.
- **Contributions over the relay** reveal the escrow FVK to the relay operator (privacy only).
- **One sale per listing**, and testnet only.
