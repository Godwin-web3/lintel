# How Lintel compares

Lintel solves one problem: selling a piece of data to someone you do not trust, so that the buyer pays only if they get exactly what was promised and the seller is paid only if they hand it over. Other approaches solve this, or something near it, with different trust and privacy trade-offs. This page compares them by design class, not by product quality.

> Lintel runs on Zcash testnet only and is unaudited. The comparison is about how the designs work, not about maturity: several of the alternatives have run with real money for years.

## At a glance

| Approach | Who must be trusted | Buyer checks the goods before paying | Payment privacy | Content after the sale |
| --- | --- | --- | --- | --- |
| **Lintel** | Nobody holds keys or funds. The relay can stall a sale and sees escrow balances; the app host serves the code | Yes: Halo 2 proof that the ciphertext opens under the payment's key to content with hash `h`, checked on the buyer's device | Shielded escrow note on Zcash; a small transparent lock coin is visible | Computable by anyone who reads the relay's session record and the mined settlement ([threat model](threat-model.md#after-the-sale)) |
| **Trusted escrow or marketplace** | The escrow agent holds the funds, usually the goods, and decides disputes | Only if the agent inspects them | Whatever the payment rail offers; the agent sees everything | Held by the agent and the buyer |
| **ZKCP on Bitcoin** (hash-locked payment plus a zero-knowledge proof) | Nobody, if the proof system's parameters are honest | Yes: the seller proves the ciphertext decrypts, under a key whose hash locks the payment, to a valid answer | Transparent Bitcoin script; the hash lock is visible on chain | The key is published in the redeeming transaction, so anyone with the ciphertext can decrypt |
| **Plain Zcash trade** (pay, then hope; or send the file, then hope) | The side that goes second trusts the side that goes first | No | Fully shielded payment | Only the buyer, if the seller delivers |
| **FHE or MPC data markets** (compute on encrypted data) | A committee or network holding key shares, under an honest-majority or threshold assumption | Often the buyer gets a computed result rather than raw data, so "checking the goods" means trusting the computation | Depends on the network | Data stays encrypted under the committee's key; a breach of enough key holders exposes it |
| **Shielded payment pools** (for example Zcash's own pool, Railgun, Gloam) | Depends on the pool: proof system setup, operators or relayers for some designs | Not applicable: these move money privately, they do not exchange data for money | Strong: hides sender, receiver and amount inside the pool | Not applicable |

## The approaches in more detail

### Trusted escrow

The familiar model: a marketplace or agent holds the buyer's money, receives the goods, and releases payment when satisfied. It handles disputes about quality, which no cryptography can, and it works with any payment method. The cost is that the agent can be breached, coerced or simply wrong, sees both parties and the content, and charges for the service. Lintel removes the agent from the exchange itself and keeps the one thing it cannot replace out of scope: whether the content is worth the price.

### ZKCP on Bitcoin

Zero-knowledge contingent payment is the idea Lintel builds on. The seller encrypts the goods under a key `K`, proves in zero knowledge that the ciphertext decrypts to something that satisfies the buyer's condition and that `SHA256(K)` is a given value, and the buyer pays to a script that requires that preimage plus the seller's signature. Redeeming the payment publishes `K` ([Bitcoin Wiki](https://en.bitcoin.it/wiki/Zero_Knowledge_Contingent_Payment); first run on Bitcoin in 2016, [announcement](https://bitcoincore.org/en/2016/02/26/zero-knowledge-contingent-payments-announcement/)). A later paper showed that letting the buyer generate the proof system's parameters, as the early protocol did, lets a malicious buyer learn part of the goods without paying ([Campanelli, Gennaro, Goldfeder, Nizzardo, 2017](https://eprint.iacr.org/2017/566)).

Where Lintel differs:

- **No trusted setup.** Halo 2 with IPA over the Pasta curves needs no parameter ceremony; the public parameter files are pinned by digest. Neither side chooses secret parameters.
- **No hash lock on chain.** The key is carried by an adaptor signature: the escrow spend is an ordinary-looking RedPallas signature, and the key is the difference between the completed signature and the two halves the parties exchanged. Nothing on chain marks the transaction as a contingent payment.
- **Shielded funds.** The escrow is a shielded note, so amounts and parties are not public.
- **Same limit after the sale.** Like ZKCP, the released key opens the ciphertext for whoever can compute it.

### Plain Zcash trades

Zcash already makes the payment private. What it does not do is tie the payment to the delivery: one side has to go first. For small amounts between people who know each other, that is fine and simpler than Lintel. Lintel adds the binding (payment and key release in one transaction) and the proof that the content matches before any money moves.

### FHE and MPC data markets

Fully homomorphic encryption and multi-party computation let a network compute on data nobody sees in the clear. That is the right tool when many parties' hidden data must be combined, such as an auction, an order book or model training on pooled data. It requires a committee or a set of nodes to hold key shares, and its safety rests on enough of them staying honest. Lintel's problem has one seller and one buyer, so it needs no committee: the proof is checked on the buyer's device, and only the two parties ever hold key material.

### Shielded payment pools

Shielded pools hide who paid whom and how much. They are payment systems, not exchange protocols: they do not make a payment conditional on receiving specific data. Lintel uses a shielded pool (Zcash's Ironwood pool on the NU7 testnet) for its escrow, and adds the conditional exchange on top.

## When not to use Lintel

- When you need someone to judge quality or settle a dispute: use a trusted escrow.
- When the content must stay secret from everyone but the buyer after the sale: Lintel does not provide that today.
- When the content is larger than 1,523,681 bytes: sell a key to a file hosted elsewhere, and the proof then covers the key, not the file.
- When real money is involved: Lintel is testnet software. See [What ships when](what-ships-when.md) and the [Production gate](production.md).
