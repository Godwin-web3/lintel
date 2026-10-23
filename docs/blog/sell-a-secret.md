# Lintel: sell a secret, get paid, nobody trusts anybody

*23 October 2026 · Lintel is open for testers on Zcash testnet*

Say you found a bug in someone's smart contract and they run a bounty. You want to be paid before you hand over the report. They want to read the report before they pay. Today one of you goes first, or you both trust a platform in the middle that holds the money, reads the report and decides who is right.

Lintel is an attempt to make that exchange mechanical. It is open source, it runs on Zcash testnet, and it is ready for people to try and break.

## How a sale works

**The seller seals the file.** In the browser, the seller's device picks a fresh secret, encrypts the file under it and produces zero-knowledge proofs (Halo 2, no trusted setup) that this ciphertext opens, under the secret behind a public point `T`, to content with a stated hash. Files up to 1,523,681 bytes work, and every byte's decryption is proven.

**The buyer checks before paying.** The buyer's browser downloads the listing and verifies the proofs locally. If the seller lied about the content, swapped a part, or bound the file to a different key, verification fails and the buyer never pays. Anyone can run this check at `/verify`, without a wallet.

**Payment and key are one transaction.** The buyer funds a shielded Zcash escrow that neither side can spend alone. To get paid, the seller has to complete an adaptor signature, and completing it is exactly what reveals the secret. The buyer's browser reads the completed signature from the mined transaction, recovers the key and decrypts. If the seller never settles, a refund the seller co-signed before any money moved becomes valid after a lock height, and the Zcash network itself refuses it before then.

The name comes from architecture: a lintel is the beam across two posts that makes a doorway. It stands only when both posts carry it.

## What already ran on testnet

These are not mock-ups. Each of these was mined on Zcash testnet and is listed with its transaction ids on the [evidence page](https://lintel-godwin-web3s-projects.vercel.app/evidence):

- A sale with both sides in the web app: funded at block 4,522,583, settled at 4,522,588, 6 minutes 34 seconds from start to decrypted file.
- A refund of an escrow that was never settled, broadcast after its lock.
- A refund broadcast too early and rejected by consensus, then mined after the lock height.
- A sale where the seller's browser was closed and the seller agent, `lintel-agent`, finished it.
- Two sales paid from a separate wallet through a ZIP 321 request, one to a transparent address and one to a shielded one.

## What it does not do

We would rather you hear the limits from us:

- **Testnet only, unaudited.** TAZ has no value. Mainnet is not planned until testnet is solid and the code has been reviewed; the list of what has to happen first is public ([production gate](../production.md)).
- **A hash is not a review.** The proof says the file matches the hash you expected. It cannot say the file is good.
- **After a sale, treat the content as public.** The key that opens the file can be computed by anyone who reads the sale's public record on the relay together with the mined settlement. Lintel makes the exchange fair; it does not keep the content exclusive afterwards. Details are in the [threat model](../threat-model.md#after-the-sale).
- **Someone has to act for the seller.** The seller's app or a running seller agent co-signs the refund and broadcasts the settlement. There is no hosted agent, on purpose: it would hold the seller's secrets.
- **Big files are slow to seal in a browser tab.** About 100 seconds per 23.8 KB part single-threaded. A 1 MB file took 9.5 minutes natively on a 2-core machine.
- **Multi-copy listings settle off-chain** for now and move no coins.

The full list is in [What ships when](../what-ships-when.md).

## Try it

1. Open the [app](https://lintel-godwin-web3s-projects.vercel.app/app), seal a line of text, and check its proof at [/verify](https://lintel-godwin-web3s-projects.vercel.app/verify). That takes about two minutes and needs no wallet.
2. For a full sale, follow the [quickstart](../quickstart.md) with two browser profiles and some faucet TAZ.
3. Tell us what broke: [tester guide](https://lintel-godwin-web3s-projects.vercel.app/testers), or open an issue on [GitHub](https://github.com/Godwin-web3/lintel/issues). Anything that could cost someone funds or leak a secret goes privately, per [SECURITY.md](../../SECURITY.md).

If you want the math, the [whitepaper](../whitepaper.md) has the construction, the security argument and every benchmark.
