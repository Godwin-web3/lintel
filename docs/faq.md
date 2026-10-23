# FAQ

**What is Lintel for?**
Selling a digital thing where the buyer needs proof before paying and the seller needs payment before revealing: a bug report, a dataset, research, a file. The buyer verifies a proof about the sealed content; payment and key release happen in one Zcash transaction.

**Why "Lintel"?**
A lintel is the beam across two posts that makes a doorway. It stands only when both posts carry it. Buyer and seller each hold half of the signature; neither can settle alone.

**Is this on mainnet?**
No. Zcash testnet only, unaudited, and mainnet is not planned until testnet is solid and the code has been reviewed ([Production gate](production.md)). Get testnet coins (TAZ) from a faucet; see the [Quickstart](quickstart.md).

**Can I check a listing without buying?**
Yes. Paste its ID into [/verify](https://lintel-godwin-web3s-projects.vercel.app/verify): your browser checks every proof, with no wallet.

**Once I buy something, is it mine alone?**
No. Lintel makes the exchange fair, but after a single-copy sale settles the key can be computed by anyone who reads the sale's public record on the relay and the mined settlement. See the [Threat model](threat-model.md#after-the-sale).

**What does the proof actually prove?**
That the ciphertext decrypts, under the secret behind the listed point `T`, to content whose hash is the listed `h`. It doesn't prove the content is useful to you; it proves you'll get exactly the content the seller committed to.

**Can the proof say anything about what is inside?**
Yes, within limits. A seller can add proven claims: the length is between two bounds, the file starts with given bytes (such as `%PDF`), or the bytes at an offset equal a public value (such as a contract address in a report header). They are proven in the same proof, over the same bytes, and the app shows them next to the verified proof. They cover the first 23.8 KB. See [Proven claims](predicates.md).

**Can the seller take my money and not give me the file?**
No. Getting paid requires completing your pre-signature with `t`, and the completed signature lands on-chain, where your app reads it and computes `t`.

**What if the seller never settles?**
Your app holds a refund the seller co-signed before you funded. Consensus rejects it until the lock height passes; after that, broadcast it and your funds come back (minus fees).

**Does the relay see my file?**
No. It stores the ciphertext and public session data. It can see escrow balances, not keys, `t` or plaintext. See [Security model](security-model.md).

**How big can a listing be?**
Up to 1,523,681 bytes (about 1.5 MB), and the decryption of every byte is proven. Files over 1,953 bytes (on-chain) or 7,905 bytes (multi-copy) are proven in 23.8 KB parts. See [Big payloads](big-payloads.md).

**Why does sealing take a while?**
The Halo 2 proofs are generated on your device so the secret never leaves it. Expect around 15 to 30 seconds for a small file in the browser. Big files take about 100 s per 23.8 KB part in a single-threaded browser tab, so over an hour for 1 MB; natively, 1 MB took 9.5 minutes on 2 vCPU.

**Do I need a wallet in the browser to buy?**
No. **Pay from another wallet** shows a ZIP 321 request you can pay from any Zcash testnet wallet, shielded or transparent. The app funds the escrow straight from that payment.

**Do I need to keep the tab open?**
As a seller of an on-chain listing, either keep **My sales** open until the buyer's payment settles, or hand the listing to the seller agent (`lintel-agent`), which finishes the sale with your browser closed ([CLI reference](cli.md#lintel-agent-seller-agent)). Multi-copy sales complete the next time you open the app. As a buyer with an open escrow, don't clear site data: your refund lives there.

**Can I run my own?**
Yes. See [Self-hosting](self-hosting.md).
