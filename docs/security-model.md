# Security model

Lintel is built so that the two parties never have to trust each other or the relay with anything that moves value. This page states what each party can see and do, what you are trusting, and where the current version falls short.

> **Status: testnet only, unaudited.** The guarantees below are design goals backed by tests and live testnet runs, not by an external audit.

## Guarantees

| Guarantee | Why it holds |
| --- | --- |
| **The buyer knows what they are paying for before paying.** | The seller publishes a Halo 2 proof that the ciphertext decrypts, under the secret behind `T = [t]·G`, to content with hash `h` (and, for disclosure listings, that a hidden value meets a stated minimum). The buyer verifies it on their own device. |
| **The seller can't be paid without handing over the key.** | The escrow spends only with a signature from the joint key. The buyer's half is an adaptor pre-signature locked to `T`; completing it requires `t`, and the completed signature is published in the settlement transaction, where the buyer reads it and computes `t`. |
| **The buyer can't take the content without paying.** | `t` exists only on the seller's device until the seller chooses to settle. The ciphertext alone reveals nothing. |
| **The buyer's money isn't stuck if the seller disappears.** | Before the buyer funds the escrow, the seller co-signs a refund. In v2 it spends both the escrow and a small transparent lock coin with `nLockTime` set past the settlement expiry, so consensus rejects it until the seller's claim window has closed (verified live: an early refund was rejected with "transaction is locked until after block height"). |
| **Neither party can settle alone.** | The escrow key is the sum of both parties' key shares, each with a proof of knowledge, so neither can bias the joint key. |

## What never leaves your device

- Wallet spending keys and the transparent lock key.
- Signing shares and nonces for both payer and merchant roles.
- The adaptor secret `t` (seller) and the signed refund (buyer).
- Plaintext content.

These live in the browser's memory and `localStorage`. Clearing site data deletes them. **Losing the signed refund while an escrow is open means losing the ability to reclaim it,** so don't clear site data mid-sale.

## What the relay sees

The relay is a public bulletin board plus a chain proxy. It stores listings (ciphertext, `T`, `h`, proof, price), session fields (verification keys, proofs of knowledge, key contributions, addresses, agreed terms, unsigned PCZTs, nonce points, partial and pre-signatures, txids) and presale orders. Session fields are write-once and each party authenticates its own writes.

What the relay operator can do with that:

- **See escrows.** Contributions plus verification keys are enough to derive the escrow's viewing key, so the operator can see escrow balances and transactions. It can't spend them or learn `t`.
- **Censor or delay.** It can drop listings or messages. That can stall a sale, and the refund path still works because it only needs the chain.
- **Not forge.** It can't produce valid proofs, signatures or transactions for either party.

Chain data goes through a lightwalletd proxy (`LINTEL_LWD`, default `testnet.zec.rocks`). Only public data passes: heights, commitment trees, note commitments, mined transactions and fully signed transactions to broadcast.

## Trust assumptions

- The Halo 2 proving system and the Pasta curves are sound, and the circuit is correctly constrained. The proving parameters are pinned by digest and served with the app.
- The app you load is the app in this repository. Lintel is a web app, so a compromised host could serve malicious code. Self-hosting removes that dependency.
- Zcash testnet consensus enforces `nLockTime` and the Orchard (Ironwood pool) spend rules.

## Known limits

- **Testnet only.** Not for real funds.
- **The seller must be online to settle.** Settlement needs the seller's app open to co-sign and broadcast before the expiry height. There is no background agent yet. If the seller misses the window, the buyer refunds.
- **Multi-copy (presale) listings settle off-chain.** The completed signature travels through the relay and no ZEC moves; the sighash and randomizer are placeholders until PCZT settlement is wired for presales, so treat presale copies as free.
- **Minimal wallet.** The built-in testnet wallet doesn't track spent notes or change across sessions.
- **Refund state is local.** The signed refund exists only in the buyer's browser storage.
- **Relay privacy.** As above, the relay operator can view escrows.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
