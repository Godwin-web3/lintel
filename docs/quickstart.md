# Quickstart

This walks through a sale on Zcash testnet using only the web app. You need two browsers or two browser profiles (one for the seller, one for the buyer), because each side keeps its keys in its own browser storage.

> Testnet only. TAZ has no value. Everything below happens on Zcash testnet.

Open the app: <https://lintel-godwin-web3s-projects.vercel.app/app>. The first load downloads the prover (WebAssembly plus a 512 KB parameter file; a second 2 MB file is fetched only when a big listing is first sealed or verified); the header shows **Prover ready** when it is done, usually in about 10 seconds.

## 1. Get testnet coins (buyer)

You can skip this section if you already have a Zcash testnet wallet: at step 3, **Pay from another wallet** lets you pay from it instead.

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
3. Tick **Settle on Zcash testnet** for an on-chain sale. On-chain listings are single copy and priced in TAZ. Any listing holds up to 1,523,681 bytes (about 1.5 MB); files over 1,953 bytes (on-chain) or 7,905 bytes (multi-copy) are proven in 23.8 KB parts, each taking roughly 100 s in a single-threaded browser tab, so a 1 MB file takes over an hour there ([big payloads](big-payloads.md)).
4. Paste the secret text or attach a file, then choose **Seal and list**. Sealing produces Halo 2 proofs on your device; a small file takes roughly 15 to 30 seconds on a laptop.
5. Open **My sales**. For an on-chain sale, someone has to co-sign the buyer's refund before the buyer funds, and broadcast the settlement afterwards: either leave **My sales** open, or choose **Hand off to agent** and run the seller agent (see [below](#sell-with-your-browser-closed)).

The seller also needs a testnet wallet to be paid into, but it can be empty: open **Wallet** and choose **Create wallet** before a buyer arrives. Its address becomes the payout address. The wallet does not pick up the payout on its own; scan the settlement txid to add it.

## 3. Buy (buyer)

1. Open the listing from **Market**. The browser verifies the listing's proof and shows **Proof verified** when the ciphertext is bound to the key the payment will be locked to.
2. Under **Buy on-chain**, check the escrow amount and choose **Buy on-chain** to pay from this browser's wallet. Or choose **Pay from another wallet**: the app opens a per-purchase pay-in wallet and shows a ZIP 321 request (QR code and URI) for the escrow, lock coin and funding fee. Pay it from any Zcash testnet wallet, to the shielded (Orchard receiver, Ironwood note) or transparent address. Once the payment is mined the app funds the escrow straight from it, and anything left over (change, the returned lock coin, a refund) can be withdrawn from **Wallet**.
3. The log shows each step: joint key, funding and refund built, refund co-signed by the seller, funding broadcast, settlement built and signed, settlement mined. Funding and settlement each wait for a block (about 75 seconds on testnet).
4. When the settlement is mined, your browser reads the completed signature from the transaction, extracts the key and decrypts. The content appears under **Unlocked**.

A recorded run of exactly this flow took 6 minutes 34 seconds end to end; see [Testnet evidence](testnet-evidence.md).

## Sell with your browser closed

On a single-copy on-chain listing, **Hand off to agent** in **My sales** downloads a handoff file holding that listing's signing share, adaptor secret and relay token. Anyone with the file can complete the sale, so keep it on a machine you control. Then, on that machine:

```bash
cd engine && cargo build --release --features agent --bin lintel-agent
B=../target/release                           # or $CARGO_TARGET_DIR/release
$B/lintel-agent import handoff.SECRET.json    # checks it against the relay
$B/lintel-agent run                           # leave running; close the browser
```

The agent co-signs the buyer's refund, builds, proves and broadcasts the settlement, and pays the price to your app wallet's address; it never holds a wallet spending key. See [CLI reference](cli.md#lintel-agent-seller-agent).

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
