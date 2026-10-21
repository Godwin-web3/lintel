# Testnet evidence

Every flow below ran on Zcash testnet (NU7, Ironwood pool, v6 transactions) and was mined. Raw records are in [`docs/testnet/`](testnet/). Amounts are in zatoshis (1 TAZ = 100,000,000 zats).

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
