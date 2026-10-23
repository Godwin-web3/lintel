# lintel-sdk

TypeScript SDK for [Lintel](https://github.com/Godwin-web3/lintel): private conditional settlement on Zcash. Seal a file with a Halo 2 proof that it decrypts to content with a stated hash, let buyers verify that proof before they pay, and settle atomically: the transaction that pays the seller is the transaction that hands the buyer the key.

Node 20+ and browsers. Ships the Lintel engine (Rust, compiled to WebAssembly) and the pinned proving parameters. **Zcash testnet only, unaudited.**

```js
import { createLintel, FileStore } from 'lintel-sdk';

const lintel = await createLintel({ store: new FileStore('./lintel-state.SECRET.json') });

// sell
const { listing } = await lintel.sell({ title: 'Bug report', price: '0.02', data: bytes });
for await (const s of lintel.sale(listing.id).watch()) console.log(s.phase, s.note);

// buy (another process)
await lintel.verify(listingId);                       // throws unless every proof checks out
const purchase = lintel.buy(listingId, { funding: 'payin' });
for await (const s of purchase.watch()) {
  if (s.payment) console.log('pay with any testnet wallet:', s.payment.uri); // ZIP 321
  if (s.done) console.log(new TextDecoder().decode(s.plaintext));
}
```

- **Verify before paying**: `lintel.verify(id)` checks the offer's Halo 2 proof(s) locally; big files (up to 1,523,681 bytes) part by part.
- **Fund two ways**: the store's testnet wallet, or a per-purchase ZIP 321 request any testnet wallet can pay (shielded or transparent).
- **Refundable**: a refund co-signed by the seller before funding, time-locked by consensus; `purchase.refund()` after the lock height.
- **Resumable**: every `step()` is idempotent; state lives in a store you choose (`FileStore`, `LocalStorageStore`, `MemoryStore`, or your own), in the same shape as the Lintel app's.
- **Interoperable**: same protocol steps as the Lintel app and `lintel-agent`; `sale.handoff()` produces a `lintel-agent` file.
- **Agents**: an approve hook (`buy(id, { approve })`) runs before funds are committed; [`lintel-mcp`](https://github.com/Godwin-web3/lintel/blob/main/docs/agents.md) builds spending limits on it.

Full reference: [docs/sdk.md](https://github.com/Godwin-web3/lintel/blob/main/docs/sdk.md). Starter app: `npm create lintel-app`.

License: MIT OR Apache-2.0.
