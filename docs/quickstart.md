# Quickstart

This walks through a sale on Zcash testnet using only the web app. You need two browsers or two browser profiles (one for the seller, one for the buyer), because each side keeps its keys in its own browser storage.

> Testnet only. TAZ has no value. Everything below happens on Zcash testnet.

Open the app: <https://lintel-godwin-web3s-projects.vercel.app/app>. The first load downloads the prover (WebAssembly plus a 512 KB parameter file); the header shows **Prover ready** when it is done, usually in about 10 seconds.

## 1. Get testnet coins (buyer)

1. In the buyer's browser, open **Wallet** and choose **Create wallet**. The wallet's spending key is generated and kept in this browser only.
2. Copy the `utest1…` address it shows.
3. Request TAZ from a testnet faucet that pays on the current (NU7) testnet. The Valar faucet, <https://faucet.testnet.valargroup.dev/>, pays 0.125 TAZ per day and accepts unified addresses. It also has an API:

   ```bash
   curl -fsS https://faucet.testnet.valargroup.dev/api/claim \
     -H 'Content-Type: application/json' \
     --data '{"address":"utest1…"}'
   ```

4. When the payment has been sent and mined, paste its transaction id under **Add a payment to this wallet** and choose **Scan**. The wallet only knows notes you scan in this way.

**How much you need.** Funding uses one note that covers the price, plus 20,000 zats of settlement fees, a 20,000-zat lock coin (returned to you) and the 15,000-zat funding fee. For a 0.02 TAZ listing that is 0.02055 TAZ in a single note.

## 2. List something (seller)

1. In the seller's browser, open **Sell**.
2. Enter a title, a public description and a price.
3. Tick **Settle on Zcash testnet** for an on-chain sale. On-chain listings are single copy. Any listing holds up to about 1.5 MB; files over 1,953 bytes (on-chain) or 7,905 bytes (multi-copy) are proven in 23.8 KB parts, each taking roughly 100 s in a single-threaded browser tab ([big payloads](big-payloads.md)).
4. Paste the secret text or attach a small file, then choose **Seal and list**. Sealing produces a Halo 2 proof on your device; it takes roughly 15 to 30 seconds on a laptop.
5. Open **My sales** and leave it open. For an on-chain sale, the seller's app has to co-sign the buyer's refund before the buyer funds, and broadcast the settlement afterwards.

The seller also needs a testnet wallet to be paid into, but it can be empty: open **Wallet** and choose **Create wallet** before a buyer arrives. Its address becomes the payout address. The wallet does not pick up the payout on its own; scan the settlement txid to add it.

## 3. Buy (buyer)

1. Open the listing from **Market**. The browser verifies the listing's proof and shows **Proof verified** when the ciphertext is bound to the key the payment will be locked to.
2. Under **Buy on-chain**, check the escrow amount and choose **Buy on-chain**.
3. The log shows each step: joint key, funding and refund built, refund co-signed by the seller, funding broadcast, settlement built and signed, settlement mined. Funding and settlement each wait for a block (about 75 seconds on testnet).
4. When the settlement is mined, your browser reads the completed signature from the transaction, extracts the key and decrypts. The content appears under **Unlocked**.

A recorded run of exactly this flow took 6 minutes 34 seconds end to end; see [Testnet evidence](testnet-evidence.md).

## If the seller disappears

The buyer's browser holds a refund that the seller co-signed before funding. Consensus rejects it until the settlement's claim window has passed (the app sets the window at 60 blocks, about 75 minutes, from when the purchase starts). After that, **Broadcast refund** appears on the listing page. The refund returns the escrow minus a 15,000-zat fee, plus the lock coin.

The signed refund lives only in that browser's local storage. Clearing site data before broadcasting it loses the escrow.

## Multi-copy listings (off-chain)

Leave **Settle on Zcash testnet** unticked and choose a number of copies. Each copy is sealed with its own secret at listing time. Buyers can order while the seller is offline: they verify the proof and pre-sign immediately, and the sale completes the next time the seller opens the app on that device, on any app page. These listings move no ZEC: the completed signature is delivered through the relay. See [How it works](how-it-works.md#multi-copy-presale-listings).

## Run it locally

```bash
# relay (Node 20+)
cd web/relay && npm start                    # http://localhost:8787
# app (Rust, wasm-pack and clang for the on-chain engine)
cd web/app && npm install && npm run wasm && npm run wasm:chain && npm run dev
```

See [Self-hosting](self-hosting.md) for deployment.
