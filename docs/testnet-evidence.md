# Testnet evidence

Every flow below ran on Zcash testnet (NU7, Ironwood pool, v6 transactions) and was mined. Raw records are in [`docs/testnet/`](testnet/). Amounts are in zatoshis (1 TAZ = 100,000,000 zats).

## Pay from another wallet (buyer without a device wallet)

Price 0.02 TAZ, seller side run only by `lintel-agent`. The buyer's app opened a per-purchase pay-in wallet and showed a ZIP 321 request for 2,055,000 zats (escrow 2,020,000 + lock coin 20,000 + funding fee 15,000). A separate wallet paid it; the buyer detected the mined payment, funded the escrow straight from it (no sweep transaction), had the time-locked refund co-signed before broadcasting the funding, and decrypted the content from the mined settlement. What was left in the pay-in wallet was then withdrawn. The paying wallet was a stand-in (a separate key driven by `live_agent_sale external-pay` that reads only the URI), not a third-party wallet app. Records: [`testnet/evidence-payin-transparent-sale.json`](testnet/evidence-payin-transparent-sale.json), [`testnet/evidence-payin-shielded-sale.json`](testnet/evidence-payin-shielded-sale.json).

| Run | Step | Height | Txid |
| --- | --- | --- | --- |
| Transparent receiver | Payment (external → pay-in t-address) | 4,529,992 | `d38a395f17644f8c27598ac5a0c5ae6c6d287dbb872ff52b793bce7b2c25e3ed` |
| Transparent receiver | Funding (from the coin) | 4,529,996 | `b5341a69d0db7c469c24d7a3b2eb44caba69aaa633e121bee4a3c50ed96de328` |
| Transparent receiver | Settlement | 4,530,002 | `f765cb4e12f3a2fa22d7afb0c6d1973a4372351460990222f72fae26405ec628` |
| Transparent receiver | Withdraw (change + lock coin) | 4,530,006 | `812fb2324cd7e224a8851c60cf842091cf61c9e06c150ed9140283e86eb38556` |
| Orchard receiver (Ironwood note) | Payment (external → pay-in UA) | 4,530,006 | `7375623f73840a1e0c5c9becc4c818fb1f7233e72899839f377fdfbc33b91bd2` |
| Orchard receiver (Ironwood note) | Funding (from the note) | 4,530,012 | `26c604cfe5dd5d9fd515668c1ddb6f05254e2cfa017cbe7ff28a3ce000536b8c` |
| Orchard receiver (Ironwood note) | Settlement | 4,530,013 | `a7575c5e61915887f8ccdd14a9cd68a7c05c155387aa8fce858ead3f5aadcf9a` |
| Orchard receiver (Ironwood note) | Withdraw (change + lock coin) | 4,530,021 | `bc7062bb80c9c806803be2b66dc0dfc970e14c929bcf4b187e6b138ae3f7d585` |

## Seller agent sale (seller's browser closed)

Price 0.02 TAZ. The seller's side was run only by `lintel-agent` (a separate process, started from the app's handoff file); the buyer used the relay's HTTP API and lightwalletd. The agent co-signed the time-locked refund (lock 4,529,955) before funding, then built, signed, proved and broadcast the settlement. The payout address received 2,000,000 zats. The buyer recovered `t` from the mined settlement and the decrypted content matched the listing's content hash. Record: [`testnet/evidence-agent-sale.json`](testnet/evidence-agent-sale.json).

| Step | Height | Txid |
| --- | --- | --- |
| Funding | 4,529,902 | `5ce0e78dd3bd61bfdeb9f09ec4c0fa08f59d97bb4c5fa06d050c40b1ef2f2b8d` |
| Settlement | 4,529,908 | `5104f5af5766142cdeeba4d742b24c37149cbfdeaadbe51dd501d99e7c9aacc2` |

## Browser sale (app UI, two browser contexts)

Price 0.02 TAZ. The buyer decrypted the content and it matched.

| Step | Height | Txid |
| --- | --- | --- |
| Funding | 4,522,583 | `75053762c15aea7b27fad758928fc3009ca86d5ee3a10e35b17162914c302534` |
| Settlement | 4,522,588 | `c51697ebe0767395dee5fc54f246eccf53dc2e071f5690808ec77776939b2b67` |

## Browser refund

An escrow funded from the app and never settled was refunded with the seller's pre-signed, time-locked refund (`nLockTime` 4,522,631).

| Step | Height | Txid |
| --- | --- | --- |
| Funding | 4,522,575 | `90446dccc95818de8808046167985311e0a6715c3580fa0de9fd24a41f8c9842` |
| Refund | 4,522,635 | `992163c4a20b3cc2e363b3720aeac8f25162c81bc795736d285b0b1bd3e43392` |

## v2 time-locked refund (CLI)

A refund broadcast before the lock height was **rejected by consensus** ("transaction is locked until after block height"); the same refund was mined after it.

| Run | Step | Height | Txid |
| --- | --- | --- | --- |
| Settle | Funding | 4,522,317 | `bf537d04a54f56ea4d2ff3a46e8e7bacf0a22443f016a8b539577e18144044e4` |
| Settle | Settlement | 4,522,319 | `5dddb2db834dec47b4723e6e48bef94466b3839b7e337b0bb57cebb25ba22b5d` |
| Refund | Funding | 4,522,324 | `78cf54eea301d14aa4998da5881e4f6f85ed7cab126b87e5a05efa733ebc16a2` |
| Refund | Refund | 4,522,335 | `e78f088e5bae544378439cf8e665fca72abe1f0f1157feaf0167acf1502963b8` |

## v1 settle and refund (CLI)

| Run | Step | Height | Txid |
| --- | --- | --- | --- |
| Settle | Funding | 4,521,270 | `da340dee5bb4a8ec11872d184c884b38aabfba3060a68e76d17df32628d6cf91` |
| Settle | Settlement | 4,521,277 | `8b4ada0992642b2a71649e08c8de8d0b00cdf90a46a2794d4e09ca7999a3c0a8` |
| Refund | Funding | 4,521,282 | `f11c111d89e870b69ade0478f7331f0e8131bac7c596846a8327832a16a235e4` |
| Refund | Refund | 4,521,289 | `633ac619a5305b961d0d3187f26cc61f6b9211a49b3bb787a30d044aee6a3f03` |

v1 refunds weren't time-locked, which left a race; v2 fixed it. See [On-chain settlement](onchain.md).
