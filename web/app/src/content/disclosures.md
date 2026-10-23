# Risk disclosures

*Last updated 23 October 2026*

## Testnet software, no real value

Lintel runs on Zcash testnet. Testnet coins (TAZ) have no monetary value, and nothing on this site is an offer to buy or sell anything of value. Mainnet is not planned until testnet is solid and the code has been reviewed internally and by an outside auditor; the conditions are on the [production gate](/docs/production) page.

## Not audited

The cryptography (Halo 2 circuits, adaptor signatures, escrow and refund construction) is backed by tests and by transactions mined on testnet, not by an external audit. It may contain bugs that lose funds or leak secrets.

## Known limits

- The signed refund lives only in the buyer's browser storage. Clearing site data while an escrow is open loses it.
- After a single-copy sale settles, the content can be decrypted by anyone who reads the sale's public record on the relay and the mined settlement.
- The relay operator can see escrow balances, and can delay or drop messages.
- Someone must act for the seller (the seller's open app or `lintel-agent`) or the sale times out and the buyer refunds after about 60 blocks.
- Multi-copy listings settle off-chain and move no coins.
- A web app is only as trustworthy as the server that delivers it. Self-host from a commit you have reviewed if that matters to you.

The full list is in [what ships when](/docs/what-ships-when) and the [threat model](/docs/threat-model).

## Not advice

Nothing here is financial, legal or tax advice.

## Reporting problems

Bugs: [GitHub issues](https://github.com/Godwin-web3/lintel/issues). Vulnerabilities: privately, per [SECURITY.md](https://github.com/Godwin-web3/lintel/blob/main/SECURITY.md).
