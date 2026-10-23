# create-lintel-app

Scaffold a Vite app that verifies and buys a [Lintel](https://github.com/Godwin-web3/lintel) listing on Zcash testnet with [`lintel-sdk`](../sdk).

```sh
npm create lintel-app my-app
# or point it at your own relay
npm create lintel-app my-app -- --relay http://localhost:8787
cd my-app && npm install && npm run dev
```

The app lists open listings, verifies the chosen listing's proof in the browser, then buys it: by default through a ZIP 321 payment request any testnet wallet can pay, or with an in-browser wallet. See [docs/sdk.md](../../docs/sdk.md#starter-app). Testnet only.
