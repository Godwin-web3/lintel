# FAQ

**What is Lintel for?**
Selling a digital thing where the buyer needs proof before paying and the seller needs payment before revealing: a bug report, a dataset, research, a file. The buyer verifies a proof about the sealed content; payment and key release happen in one Zcash transaction.

**Why "Lintel"?**
A lintel is the beam across two posts that makes a doorway. It stands only when both posts carry it. Buyer and seller each hold half of the signature; neither can settle alone.

**Is this on mainnet?**
No. Zcash testnet only, unaudited. Get testnet coins (TAZ) from a faucet; see the [Quickstart](quickstart.md).

**What does the proof actually prove?**
That the ciphertext decrypts, under the secret behind the listed point `T`, to content whose hash is the listed `h`. It doesn't prove the content is useful to you; it proves you'll get exactly the content the seller committed to.

**Can the seller take my money and not give me the file?**
No. Getting paid requires completing your pre-signature with `t`, and the completed signature lands on-chain, where your app reads it and computes `t`.

**What if the seller never settles?**
Your app holds a refund the seller co-signed before you funded. Consensus rejects it until the lock height passes; after that, broadcast it and your funds come back (minus fees).

**Does the relay see my file?**
No. It stores the ciphertext and public session data. It can see escrow balances, not keys, `t` or plaintext. See [Security model](security-model.md).

**Why does sealing take a while?**
The Halo 2 proof is generated in your browser so the secret never leaves it. Expect around 15 to 30 seconds for about 1 KB.

**Do I need to keep the tab open?**
As a seller, yes, until a buyer's on-chain payment settles. As a buyer with an open escrow, don't clear site data: your refund lives there.

**Can I run my own?**
Yes. See [Self-hosting](self-hosting.md).
