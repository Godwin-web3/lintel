# SDK (TypeScript)

`lintel-sdk` is the Lintel engine and relay protocol as a TypeScript library for Node and the browser. It seals and lists files, verifies offers and their Halo 2 proofs, funds escrows (in-app wallet or a ZIP 321 pay-in request any testnet wallet can pay), watches a sale, settles, unlocks, and refunds. It runs the same Rust engine as the app, compiled to WebAssembly, and follows the same steps as the app and `lintel-agent`, so the three interoperate on one relay.

> **Zcash testnet only, unaudited.** Don't use real funds.

Also in this repo: [`create-lintel-app`](#starter-app) (a Vite starter), [runnable examples](#examples), and an MCP server for AI agents ([Agents](agents.md)).

## Install

```sh
npm install lintel-sdk
```

Not yet on npm: until it is published, build it from this repo (`packages/sdk`, see [Build from source](#build-from-source)) and install the packed tarball or use the npm workspace at the repo root.

Node 20 or newer, or a modern browser. The package ships its own WASM and the pinned proving parameters (their digests are pinned inside the WASM, so a swapped file is rejected).

## Quick start

```js
import { createLintel, FileStore } from 'lintel-sdk';

// Keys (signing shares, adaptor secrets, wallet keys) live in the store, never on the relay.
const lintel = await createLintel({
  relayUrl: 'https://lintel-relay.onrender.com', // the hosted testnet relay (default)
  store: new FileStore('./lintel-state.SECRET.json'), // Node; mode 0600
});

// Seller: seal and list
const { listing } = await lintel.sell({ title: 'Bug report: Acme vault', price: '0.02', data: reportBytes });

// Buyer: verify the proof locally, then buy on testnet
const proof = await lintel.verify(listing.id); // throws if any proof fails
const purchase = lintel.buy(listing.id, { funding: 'payin' }); // or 'wallet'
for await (const step of purchase.watch()) {
  if (step.payment) console.log('pay', step.payment.uri); // ZIP 321 request
  console.log(step.phase, step.note);
  if (step.done) save(step.plaintext);
}
```

The seller side has to run while a buyer is buying: `lintel.sale(id).watch()` in a long-running process, the Lintel app, or [`lintel-agent`](cli.md#lintel-agent-seller-agent) via [`sale.handoff()`](#sale).

## How a purchase runs

Each `purchase.step()` and `sale.step()` reads the relay session and local state, does the next thing, and returns. Steps are idempotent and resumable, so a process can crash and continue. On chain (mode `'chain'`, the default):

| Buyer phase | What happened |
| --- | --- |
| `awaiting_payment` | pay-in only: waiting for the external wallet's payment to be mined |
| `joined` | session open; key proof and contribution sent; waiting for the seller to bind the escrow key |
| `refund` | funding built and proven locally (not broadcast); the seller co-signs a refund time-locked until block E = tip + 60 |
| `funding` | refund signed and stored locally, then funding broadcast; waiting for it to be mined |
| `funded` | escrow mined; waiting for the seller's settlement |
| `settle` | settlement checked against the agreed terms; fresh nonce sent |
| `presigned` | pre-signed, locked to the verified T |
| `broadcast` | seller broadcast the settlement (which publishes t) |
| `done` | t read from the mined settlement, verified locally, content decrypted |

The seller refuses to build or broadcast the settlement within 10 blocks of E; after E the buyer can broadcast the refund. Details: [On-chain settlement](onchain.md) and [Security model](security-model.md).

Mode `'relay'` is an off-chain rehearsal of the same adaptor-signature exchange through the relay. No funds move. It is what the SDK's tests and the examples use to run end to end without testnet coins.

## API reference

### `createLintel(options?)`

Returns a `Lintel` client. Node resolves `lintel-sdk` to the Node build (WASM and parameters read from the package); browsers and bundlers get the browser build.

| Option | Default | |
| --- | --- | --- |
| `relayUrl` | `https://lintel-relay.onrender.com` | Relay base URL |
| `store` | `MemoryStore` | Where device-local state lives (see [Stores](#stores)) |
| `fetch` | `globalThis.fetch` | Custom fetch |
| `paramsBase` | bundled | Browser only: base URL serving `params.bin` and `params-big.bin` |

### Discovery and verification

| Method | Returns |
| --- | --- |
| `lintel.listings()` | All listings, newest first (list view, offers omitted) |
| `lintel.listing(id)` | `{ listing, session }`: one listing with its offer and current session |
| `lintel.status(id)` | `ListingStatus`: `phase`, relay `status`, `mode`, `txids`, `label` |
| `lintel.verify(idOrListing)` | `VerifyResult` or throws. Verifies every proof locally against the listing's content hash and checks the offer's T matches the listing |

`VerifyResult`: `{ ok, listingId, tPoint, contentHash, size, kind: 'single' \| 'big' \| 'presale', parts, ms }`. A single proof covers up to 1,953 bytes; bigger files (up to 1,523,681 bytes) are proven in parts of 23,808 bytes, fetched by content address and re-hashed before their proofs are checked ([Big payloads](big-payloads.md)). Presale listings are verified copy by copy.

### Selling

`lintel.sell(input)` seals the data under a fresh adaptor secret, uploads proven parts if it is big, and creates the listing. The seller's signing share and adaptor secret go to the store.

| `input` | |
| --- | --- |
| `title` | Required, up to 120 characters |
| `price` | Decimal TAZ string, up to 8 decimals, e.g. `"0.02"` |
| `data` | `Uint8Array` or string (UTF-8) |
| `description` | Up to 2,000 characters |
| `filename` | Shown to buyers |
| `onProgress` | `{ part, parts, ms }` while proving parts, `{ uploaded, blobs }` while uploading |

Returns `{ listing, sellerToken, kind, sealMs }`. Sealing big files is slow: each part is one Halo 2 proof on a single thread.

### `Sale`

`lintel.sale(listingId, { payoutAddress? })` is the seller's side of one listing in this store.

| Method | |
| --- | --- |
| `step()` | One step: `{ phase, note, done?, txids }`. Phases: `listed`, `joined`, `escrow`, `refund_cosigned`, `funding`, `settlement_built`, `partial_sent`, `broadcast`, `sold`, `delegated` |
| `watch({ intervalMs?, signal?, timeoutMs?, onStep? })` | Async iterator of steps until sold |
| `handoff({ payoutAddress? })` | Returns the [`lintel-agent`](cli.md#lintel-agent-seller-agent) handoff file (SECRET) and marks the listing delegated, so this store and the agent never race on the relay's write-once fields |
| `takeBack()` | Undo a handoff (stop the agent for it first: `lintel-agent remove <id>`) |

On chain the price is paid to `payoutAddress`, or to the store's wallet address if none is given. The seller checks the buyer's key proof before binding the escrow key, checks the refund terms and window before co-signing, and re-derives every value from its own checks.

### `Purchase`

`lintel.buy(listingId, options?)` returns a `Purchase`. Nothing happens until `step()`.

| Option | Default | |
| --- | --- | --- |
| `mode` | `'chain'` | `'chain'` (Zcash testnet escrow) or `'relay'` (off-chain rehearsal) |
| `funding` | `'wallet'` | `'wallet'` (one store-wallet note covers escrow + lock coin + fee) or `'payin'` (a ZIP 321 request any testnet wallet can pay) |
| `approve` | none | `async (info) => void`, called before the funding is built and again before it is broadcast; throw to stop (then `cancel()`, nothing has moved). `info`: `stage`, `listingId`, `priceZats`, `outlayZats`, `sellerAddress`, `escrowAddress`, `funding` |

| Method | |
| --- | --- |
| `step()` | One step: `BuyStep` `{ phase, note, done?, plaintext?, payment?, refund?, txids }` |
| `watch(opts)` / `complete(opts)` | Steps until done; `complete` resolves to the plaintext |
| `paymentRequest()` | The pay-in request `{ amount, uri, uriTransparent, address, transparentAddress }` |
| `refundStatus()` | `{ lockHeight, tip, ready, txid, broadcast }` once the refund is signed |
| `refund()` | Broadcasts the co-signed refund (only after its lock height; the node enforces it) |
| `cancel()` | Abandons a purchase whose funding was not broadcast; releases the reserved wallet note |
| `txids()` | `{ funding?, settlement?, refund? }` |
| `sessionId()` | Relay session id once joined |

With the store wallet, the purchase needs one note of at least the escrow (price + 20,000 zats) plus the lock coin (20,000 zats) plus the funding fee (15,000 zats): 0.02055 TAZ for a 0.02 TAZ listing (`walletNeedFor(zats('0.02'))`). A pay-in request asks for the same amount.

### Wallets

`lintel.wallet` (testnet, keys in the store):

| Method | |
| --- | --- |
| `create()` | New Ironwood wallet; returns its `utest1…` address |
| `import(text)` | `lintel-chain wallet` JSON or a 32-byte hex key |
| `scan(txid)` | Adds this wallet's notes from a mined transaction (e.g. a faucet payment) |
| `sync({ from?, maxBlocks? })` | Trial-decrypts compact blocks from `from` (or where the last sync stopped) to the tip: adds notes paying this wallet and marks spent ones (nullifiers). Up to 2,000 blocks per call |
| `info()` / `address()` / `balance()` / `spendable()` | Public view; no keys |
| `exportKey()` | SECRET spending key, for callers with their own key storage |

`lintel.payin` (one pay-in wallet per purchase, created by `buy(id, { funding: 'payin' })`): `open(listing)`, `scan(id)` (re-reads its coins and notes from public chain data; the relay can hide a payment, never invent one), `status(id)`, `balance(id)`, `withdraw(id, address)` (sweeps refunds, change and the returned lock coin to any testnet address), `backup(id)` (SECRET, same format as the app's).

### Helpers

| Export | |
| --- | --- |
| `listingStatus(listing, session)` | Pure: where a sale stands from public relay data |
| `txids(session)` | `{ funding?, settlement? }` |
| `txUrl(relayUrl, txid)` | Relay URL of a raw mined transaction |
| `zats('0.02')` / `fmtZec(2000000)` | Exact decimal TAZ to zats and back |
| `escrowFor(price)` / `walletNeedFor(price)` | Escrow note value / what a wallet-funded purchase needs, in zats |
| `LOCK_VALUE`, `SETTLE_FEE`, `FUND_FEE`, `CLAIM_BLOCKS`, `SAFETY_BLOCKS` | 20,000, 10,000 and 15,000 zats; 60 and 10 blocks (checked against the WASM engine in the tests) |
| `RelayClient` | Typed client for every relay route (listings, sessions, chain fields, blobs, chain proxy) |
| `Engine` | The WASM engine: `seal`, `verifyOffer`, `verifyUnit`, `contentHash`, payer/merchant primitives, `chain()` for the on-chain module |

### Stores

State is one JSON document with the same shape as the app's `localStorage` entry `lintel.v1` (`selling`, `buying`, `wallet`, `payins`), so a seller entry can become a `lintel-agent` handoff file and state can move between the app and the SDK. It holds SECRET material: signing shares, adaptor secrets, wallet keys, signed refunds.

| Store | |
| --- | --- |
| `MemoryStore` | In memory (default) |
| `FileStore(path)` | Node; JSON written atomically with mode 0600 |
| `LocalStorageStore(key = 'lintel.v1')` | Browser |
| your own | Implement `{ load(), save(state) }` |

`lintel.exportState()` returns the whole document (SECRET).

## Live on testnet

A complete on-chain sale driven only by the SDK (seller and buyer in separate stores, a local relay proxying the public testnet lightwalletd, buyer funding from its store wallet after `wallet.sync`): funding mined at block 4,531,679, settlement at 4,531,685, the buyer's plaintext matched, the seller was paid 0.001 TAZ. Record: [docs/testnet/evidence-sdk-sale.json](testnet/evidence-sdk-sale.json).

## Starter app

```sh
npm create lintel-app my-app   # -- --relay http://localhost:8787 for a local relay
cd my-app && npm install && npm run dev
```

A Vite app that lists open listings, verifies the chosen listing's proof in the browser, and buys it on testnet: by default through a ZIP 321 request any testnet wallet can pay, or with an in-browser wallet. Source: [`packages/create-lintel-app`](../packages/create-lintel-app/README.md). Its `vite.config.ts` excludes `lintel-sdk` from dependency pre-bundling so the WASM and parameter files load from the package.

## Examples

[`examples/`](../examples/README.md):

| File | |
| --- | --- |
| `seller.mjs` | Seal a file or text and list it; `--watch` finishes sales; `--handoff` writes a `lintel-agent` file |
| `buyer.mjs` | Verify a listing; `--buy` with `--funding payin` or a wallet; `--refund` |
| `agent.mjs` | An AI agent buying through `lintel-mcp` under owner-set spending limits |
| `rehearsal.mjs` | Seller and buyer in one process, off-chain rehearsal |

## Browser notes

- Bundlers: exclude `lintel-sdk` from pre-bundling (Vite: `optimizeDeps.exclude`) so `new URL('…', import.meta.url)` asset references survive.
- Verification, sealing and transaction proving run on the calling thread. In a page, a single proof takes seconds and a funding transaction's proof longer; run the SDK in a Web Worker for a responsive UI (the Lintel app does this with its own worker).
- The Lintel app's CSP (`script-src 'self' 'wasm-unsafe-eval'`) is what a host page needs for the WASM.

## Build from source

```sh
cd packages/sdk
npm run build:wasm   # Rust + wasm-pack: wasm/core, wasm/chain, params/ (needs clang for the chain module)
npm run build        # TypeScript -> dist/ (ESM + .d.ts)
npm test             # against a local relay (web/relay) started by the tests
```

Optional test suites: `LINTEL_TEST_NETWORK=1` (pay-in request against the public testnet through a local relay), `LINTEL_TEST_BIG=1` (a big payload sealed and proven in parts; minutes).
