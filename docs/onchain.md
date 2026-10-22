# On-chain settlement on Zcash testnet

Status: **working end to end on the public testnet**, from the CLI and, for single-copy
(v1) listings, from the browser app (two browsers + relay, no CLI), and with the seller's browser closed through the seller
agent (`lintel-agent`, see [Seller agent](#seller-agent-browser-closed)). Buyers can pay from
any testnet wallet, shielded or transparent (see [Pay from another wallet](#pay-from-another-wallet)). Multi-copy presale
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

A seller ticks "Settle on Zcash testnet" when listing. A buyer either uses a funded device wallet
(Wallet page: create or import a key, then scan a txid that paid it) and clicks "Buy with this
device's wallet", or clicks "Pay from another wallet" and pays a ZIP 321 request from any testnet
wallet ([Pay from another wallet](#pay-from-another-wallet)).
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

## Pay from another wallet

A buyer no longer needs a funded device wallet. "Pay from another wallet" shows a ZIP 321
payment request (QR code + URI) that **any Zcash testnet wallet** can pay; once the payment is
mined the app funds the escrow from it and the sale continues exactly as before.

**Why not pay the escrow directly?** The time-locked refund is pre-signed over the exact escrow
note (its `rho`/`rseed`, known only to whoever builds the funding transaction), and the funding
must also create the buyer's 20,000-zat lock coin at `vout 0`. A plain wallet payment can do
neither. So each purchase gets its own **pay-in wallet**: one Ironwood spending key and one
transparent key, generated and stored on the device (like the device wallet) *before* its
address is shown. The external wallet pays the pay-in wallet; the app builds the funding and the
refund itself, so every existing safety property is unchanged: the refund is co-signed before the
funding is broadcast, and the funding is built and proven on the device.

**Which pools can external wallets pay on today's testnet?** (decision record)

- *Orchard pool:* closed to new value since NU6.3 ([ZIP 258](https://zips.z.cash/zip-0258)).
  Pre-NU6.3 wallets cannot send there; their shielded sends fail.
- *Ironwood pool:* receivers are scoped to the Orchard **protocol**, not to a pool
  ([ZIP 326](https://zips.z.cash/zip-0326)), so an NU6.3-aware wallet (for example Zallet
  v0.1.0-beta.1, which ships Ironwood support; Zodl 3.8.0+ on mainnet) pays an ordinary Orchard
  receiver with an **Ironwood note**. There is no separate "Ironwood address" to support. Which
  third-party wallets do this *on testnet* today was not tested here.
- *Transparent (P2PKH):* every wallet, node and exchange can pay it, including wallets whose
  shielded support has not caught up with NU6.3 (e.g. the Zcash fork node of
  [ShieldedLabs/zero#3](https://github.com/ShieldedLabs/zero/pull/3), which sends transparent and
  Sapling only).
- *Sapling:* not offered. The engine has no Sapling code; a wallet that only does Sapling falls
  back to the transparent receiver.

The request is therefore a Unified Address with **two receivers**, Orchard-protocol and P2PKH
(`payin::payment_ua`). Wallets pick the most preferred receiver they support (ZIP 316), so
NU6.3 wallets pay privately and everything else pays transparent. A second URI with the bare
`tm…` address is shown for wallets that cannot read UAs.

**No sweep transaction.** The funding transaction spends the payment directly: an Ironwood note
as a shielded spend, or P2PKH coins as transparent inputs (`payin::build`, standard
`zcash_primitives` `Builder`; the `DeferredPcztBuilder` used for escrow spends takes no
transparent inputs). v6 txids exclude transparent signatures and shielded proofs (ZIP 244), so the
funding txid, the escrow note and the lock outpoint are fixed before anything is signed, which is
all the refund needs. Both shapes cost the same 15,000-zat fee (2 Ironwood actions + 1 transparent
logical action), so one request amount works for either receiver:
**price + 20,000 (settlement fees) + 20,000 (lock coin, returned) + 15,000 (funding fee)**.
A single sweep-then-fund design was considered and rejected: one more transaction, one more
confirmation, one more fee, and an extra window in which funds sit in a state the refund does not
cover, for no safety gain.

**Detection** (all public data through the relay, nothing trusted):

- Transparent: `GET /chain/utxos/:taddr` (lightwalletd `GetAddressUtxos`). Each claimed coin is
  re-read from the raw mined transaction and checked in WASM (`payin::utxo_from_tx`: the bytes
  match the txid, the output exists and pays the pay-in t-address with that value).
- Ironwood: `GET /chain/compact/:from/:to` (Ironwood compact actions, ≤100 blocks per call) is
  trial-decrypted in the browser (`payin::scan_compact`); a hit is fetched in full and decrypted
  with `chain::find_notes`. Nullifiers seen in later blocks mark notes spent.
- A lying relay can hide a payment (the buyer sees "waiting") but cannot invent one or change
  its value. Only mined payments count (one confirmation).

The app watches every 15 s and, once the pay-in wallet covers the escrow + lock coin + fee
(`payin::select`: all coins, plus at most one Ironwood note so the funding has one anchor), opens
the session and continues automatically. The session is opened only **after** the payment is
mined, so a slow wallet never holds the seller's app or agent up.

**Recovery.** Refund, settlement change and the returned lock coin are paid to the pay-in wallet.
The Wallet page lists every pay-in wallet with its balance, a Scan button, **Withdraw**
(sweeps everything to any `utest1…`/`tm…` address; one Ironwood note per transaction plus all
coins) and **Download backup** (the two keys + request, importable on another device). If the
listing sells to someone else while the buyer is paying, or the buyer changes their mind, the
payment is withdrawn the same way. If the browser's storage is cleared without a backup, a
pay-in wallet's funds are lost, exactly as with the device wallet and its signed refund.

**Privacy.** A shielded payment keeps the payer private. A transparent payment links the paying
address to the funding transaction (and the lock coin already links funding and refund on chain).
A fresh pay-in wallet per purchase keeps purchases unlinkable to each other.

**Later (not built):** an unsigned funding PCZT handed to a PCZT-capable external wallet (e.g. a
hardware wallet) to sign directly, without the pay-in hop.

**Live runs (2026-10-22, Zcash testnet, local relay, public testnet lightwalletd, seller =
`lintel-agent` with the seller's app closed).** The "external wallet" is a stand-in
(`live_agent_sale external-pay`): a separate throwaway key that reads only the ZIP 321 URI,
takes the receiver from the address and pays from its own Ironwood note. No third-party wallet
app was driven.

| Run | What | Height | Txid |
| --- | --- | --- | --- |
| A: transparent receiver | External wallet → pay-in t-address, 2,055,000 zats | 4,529,992 | `d38a395f17644f8c27598ac5a0c5ae6c6d287dbb872ff52b793bce7b2c25e3ed` |
| A | Funding from that coin (escrow 2,020,000 + lock coin at vout 0; no sweep tx) | 4,529,996 | `b5341a69d0db7c469c24d7a3b2eb44caba69aaa633e121bee4a3c50ed96de328` |
| A | Settlement by `lintel-agent` (seller +2,000,000; change 10,000 to the pay-in wallet) | 4,530,002 | `f765cb4e12f3a2fa22d7afb0c6d1973a4372351460990222f72fae26405ec628` |
| A | Withdraw: change note + lock coin → the external wallet's UA (15,000 after fee) | 4,530,006 | `812fb2324cd7e224a8851c60cf842091cf61c9e06c150ed9140283e86eb38556` |
| B: Orchard-protocol receiver | External wallet → pay-in UA, paid as an **Ironwood note**, 2,055,000 zats | 4,530,006 | `7375623f73840a1e0c5c9becc4c818fb1f7233e72899839f377fdfbc33b91bd2` |
| B | Funding from that note (found by compact-block trial decryption) | 4,530,012 | `26c604cfe5dd5d9fd515668c1ddb6f05254e2cfa017cbe7ff28a3ce000536b8c` |
| B | Settlement by `lintel-agent` | 4,530,013 | `a7575c5e61915887f8ccdd14a9cd68a7c05c155387aa8fce858ead3f5aadcf9a` |
| B | Withdraw: change note + lock coin → a `tm…` address | 4,530,021 | `bc7062bb80c9c806803be2b66dc0dfc970e14c929bcf4b187e6b138ae3f7d585` |

In both runs the refund (locks 4,530,053 and 4,530,068) was co-signed by the agent and stored
before the funding was broadcast, the buyer recovered `t` from the mined settlement, and the
decrypted content matched the listing's content hash. Records:
[`testnet/evidence-payin-transparent-sale.json`](testnet/evidence-payin-transparent-sale.json),
[`testnet/evidence-payin-shielded-sale.json`](testnet/evidence-payin-shielded-sale.json).

An earlier attempt the same day (listing `V9sgRpyJ7aVx`) also completed on chain (payment
`4e0d2f44ee5f8c343cc6d88fbd28df9f8b7a634e2e76d425bd38ee674803ffa2` at 4,529,968, funding
`81c48b508af5b95d578fb949930c21f2f6caeda8e3b62a28c88bb51ff705a43e` at 4,529,969, settlement
`934fe4c23b327335434c9bcaf9225783eb952958b7c1c6fb0ddae36dd03338ec` at 4,529,971; the payout
wallet received 2,000,000), but the build machine was rolled back mid-run and the buyer's local
records (including its decryption check) were lost, so it is not counted as evidence.

Reproduce (after the [Seller agent](#seller-agent-browser-closed) setup; `demo/` holds the
external wallet's `payer-wallet.json` + `payer-change-note.json`):

```bash
$B/examples/live_agent_sale demo seller http://127.0.0.1:8787
$B/lintel-agent import demo/handoff.SECRET.json --dir demo/agent && $B/lintel-agent run --dir demo/agent &
$B/examples/live_agent_sale demo payin-request http://127.0.0.1:8787   # writes demo/payin-request.json (URI)
$B/examples/live_agent_sale demo external-pay transparent              # or: orchard
$B/examples/live_agent_sale demo buyer http://127.0.0.1:8787 payin      # waits for the payment, then buys
$B/examples/live_agent_sale demo payin-withdraw <utest1…|tm…>           # sweep what is left
```

## Seller agent (browser closed)

"Hand off to agent" on a single-copy on-chain listing (My sales) downloads a handoff file
with that listing's signing share, adaptor secret and relay token. `lintel-agent import <file>`
checks it against the relay (T and merchant key must match the listing), and `lintel-agent run`
then does the seller's steps S1 to S5 with no browser: checks the buyer's key proof, binds the
escrow key, co-signs the time-locked refund, builds the settlement once the funding is mined,
signs, proves and broadcasts it. It re-runs every check the seller's app makes
(`engine/src/agent.rs`) and talks to lightwalletd directly (`LINTEL_LWD`). Payouts go to the
address in the handoff file; the agent holds no wallet spending key. Whoever holds the handoff
file or the agent directory can complete the sale, so keep them on a machine you control.

**Live run (2026-10-22, Zcash testnet, local relay, public testnet lightwalletd).** The
seller command published the listing, wrote the handoff file in the app's format and exited.
From then on the only seller-side process was `lintel-agent run`. The buyer
(`engine/examples/live_agent_sale.rs`, the same steps as the app's `advanceBuyer`) talked only
to the relay's HTTP API and lightwalletd.

| What | txid | Height |
| --- | --- | --- |
| Faucet → buyer wallet (12,500,000 zats) | `cda8d138eaf0f66f57495c8c6b4cfa0cc864b8916a46506e777f55cd693ed800` | 4,529,887 |
| Funding (buyer → joint escrow 2,020,000 zats, + 20,000-zat lock coin) | `5ce0e78dd3bd61bfdeb9f09ec4c0fa08f59d97bb4c5fa06d050c40b1ef2f2b8d` | 4,529,902 |
| Settlement (built, signed, proved and broadcast by `lintel-agent`; expiry 4,529,955) | `5104f5af5766142cdeeba4d742b24c37149cbfdeaadbe51dd501d99e7c9aacc2` | 4,529,908 |

The agent co-signed the buyer's refund (locked until block 4,529,955) before the funding was
broadcast. The payout address received 2,000,000 zats. The buyer read the mined settlement,
recovered `t` from its spend-auth signature, and the decrypted content matched the listing's
content hash (`decrypted_matches_content_hash: true`). The relay never held a completed
signature. The buyer's and seller's key shares needed negation in this run (ỹ(ak) = 1), so the
negation path was exercised live. Record:
[`testnet/evidence-agent-sale.json`](testnet/evidence-agent-sale.json).

Reproduce (local relay; `NO_PROXY=127.0.0.1` if an HTTP proxy is set in your environment):

```bash
cd engine
cargo build --release --features agent --bins --example live_agent_sale
B=$CARGO_TARGET_DIR/release   # or ../target/release
# demo/ holds payer-wallet.json + payer-source-note.json (see Reproduce above)
(cd ../web/relay && node server.js &)                            # port 8787
$B/examples/live_agent_sale demo seller http://127.0.0.1:8787     # lists, writes demo/handoff.SECRET.json, exits
$B/lintel-agent import demo/handoff.SECRET.json --dir demo/agent
$B/lintel-agent run --dir demo/agent &                           # the only seller-side process
$B/examples/live_agent_sale demo buyer http://127.0.0.1:8787      # writes demo/evidence-agent-sale.json
```

Browser-flow limits (as of this branch):

- **Someone must act for the seller during a sale.** The refund is co-signed *before* the
  buyer funds, and the settlement must be broadcast before its expiry, or the buyer takes the
  refund after it. That is either the seller's open app or the seller agent (`lintel-agent`,
  [above](#seller-agent-browser-closed)), which must be running when a buyer starts and until
  the settlement is mined. The agent is a process the seller runs (laptop, VPS); there is no
  hosted agent.
- **Presale (multi-copy, v2) listings are not wired on-chain.** They still settle off-chain.
- **The device wallet is minimal.** It only knows notes you scan in by txid; it marks a note
  spent only when this device funds an escrow with it. It does not scan the chain for spends
  made elsewhere (e.g. the same key imported on two devices), and it does not add change,
  refund or payout notes automatically — scan their txids. Funding needs one note that covers
  escrow + lock coin + fee. (Pay-in wallets, used by "Pay from another wallet", do scan the chain
  for their own payments, change, refunds and spends.)
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
| Engine, feature `agent` (2026-10-22, branch `seller-agent`) | lib 31 passed; `tests/agent.rs` 5 passed (offline sale with the seller absent, rogue buyer key, early-unlock refund, near-expiry refusal, handoff checks); settlement 1 passed | `cargo test --release --features agent` in `engine/` |
| Live, seller agent | 1 sale settled on testnet with the seller's browser closed (table above) | `examples/live_agent_sale` + `lintel-agent` |
| Engine, feature `agent` (2026-10-22, branch `real-wallet-funding`) | lib 33 passed (adds ZIP 321 and two-receiver UA unit tests); `tests/agent.rs` 5 passed; `tests/payin.rs` 3 passed (transparent payment → funding → refund pre-signed → settlement → sweep; Ironwood payment found by compact scan → funding; split/short/overpaid payments); settlement 1 passed | `cargo test --release --features agent` in `engine/` |
| wasm, feature `chain` (same branch) | 6 passed (adds `payin_bindings_detect_and_fund_offline`) | `cargo test --release --features chain` in `wasm/` |
| Relay (same branch) | 14 passed (adds `/chain/utxos` and `/chain/compact`) | `node --test` in `web/relay` |
| Live, pay from another wallet | 2 sales settled on testnet, one paid to the transparent receiver, one to the Orchard-protocol receiver (Ironwood note), plus 2 withdrawals | `examples/live_agent_sale` (`payin-request`, `external-pay`, `buyer … payin`, `payin-withdraw`) |

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
  [Browser flow](#browser-flow-single-copy-listings)), with its limits: the seller's app or a
  running `lintel-agent` must co-sign the refund before funding, presale listings not wired, minimal wallet that does
  not track spends made elsewhere, refund kept only in localStorage, and the production
  (Vercel) build of the on-chain engine unverified (needs clang; stub fallback).
- **Refund timelock:** implemented (item 5, v2). The `lintel-chain` CLI subcommands accept
  the new `lock`/`t_out` terms fields through JSON. There is no CLI subcommand yet to create
  or sign a transparent key; the `testnet_sale` harness does it.
- **Contributions over the relay** reveal the escrow FVK to the relay operator (privacy only).
- **One sale per listing**, and testnet only.
