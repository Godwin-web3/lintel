# Lintel starter

A Vite app that lists [Lintel](https://github.com/Godwin-web3/lintel) listings, verifies a listing's Halo 2 proof in the browser, and buys it on **Zcash testnet** with [`lintel-sdk`](https://github.com/Godwin-web3/lintel/blob/main/docs/sdk.md).

```sh
npm install
npm run dev
```

- **Relay**: set `VITE_LINTEL_RELAY` in `.env` (default: the hosted testnet relay).
- **Funding**: "pay from any testnet wallet" shows a ZIP 321 request; the app watches the chain and continues once the payment is mined. Or create an in-browser wallet and scan a faucet payment into it.
- **Keys**: stored in this browser's localStorage (`lintel-starter.v1`). They never reach the relay.
- **Unlock**: the decryption key comes from the mined settlement transaction and is verified in the browser before decrypting.

Proving and verification run on the page's main thread, so the tab is busy for a few seconds during verification and while the funding transaction is proven. Testnet only, unaudited: don't use real funds.
