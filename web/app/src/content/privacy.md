# Privacy

*Last updated 23 October 2026*

Lintel is built so that the people running it learn as little as possible. This page says what is stored, where, and who can see it.

## No accounts, no tracking

There are no user accounts. The site sets no cookies and loads no analytics, advertising or third-party scripts; its content security policy blocks external scripts and fonts.

## What stays on your device

Your browser's local storage keeps wallet spending keys, signing shares and nonces, the unlock secret (for sellers), the signed refund (for buyers), pay-in wallet keys, and decrypted content. None of this is sent to the relay. Clearing site data deletes it, and nobody can recover it for you.

## What the public relay stores

The relay is a public bulletin board. It stores, and serves to anyone:

- listings: title, description, price, content hash, the public point `T`, ciphertext and proofs (big files as content-addressed blobs);
- sale records: verification keys, proofs of knowledge, key contributions, testnet addresses, agreed transaction terms, unsigned transactions, nonce points, partial and pre-signatures, and transaction ids;
- multi-copy orders and completions.

From these fields the relay operator can derive an escrow's viewing key and see its balance and transactions; it cannot spend them. After a single-copy sale settles, anyone who reads the sale's record together with the mined settlement can compute the key that opens the content. See the [threat model](/docs/threat-model).

The relay also forwards public chain requests (block heights, commitment trees, transactions, broadcasts) to a lightwalletd server.

## Hosting

The app is served by Vercel and the public relay by Render. As with any website, those providers process network data such as IP addresses to deliver requests, under their own privacy policies. The relay code in this repository does not log requests.

## On chain

Transactions on Zcash testnet are public. Shielded amounts and addresses are hidden by Zcash itself; the transparent lock coin used by refunds, and payments to a transparent pay-in address, are visible.

## Contact

Open an issue on [GitHub](https://github.com/Godwin-web3/lintel/issues), or email the address in [SECURITY.md](https://github.com/Godwin-web3/lintel/blob/main/SECURITY.md) for anything sensitive.
