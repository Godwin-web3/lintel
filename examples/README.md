# Examples

Runnable `lintel-sdk` examples. From the repo root: `npm install && npm run build`, then run them from this folder. They talk to the hosted testnet relay unless you pass `--relay` (or set `LINTEL_RELAY_URL`); for a local relay run `node web/relay/server.js` (port 8787).

Zcash **testnet** only. Files named `*.SECRET.json` hold keys: keep them private.

## Off-chain rehearsal (no coins needed)

```sh
node rehearsal.mjs --relay http://localhost:8787
```

Seller and buyer in one process: seal and list, verify the proof, run the adaptor-signature exchange through the relay, decrypt. No funds move.

## Seller: seal and list

```sh
node seller.mjs --file report.md --title "Bug report: Acme vault" --price 0.02 --wallet-create --watch
```

Seals the file (one Halo 2 proof up to 1,953 bytes; larger files in proven parts), lists it, and with `--watch` answers buyers until it is sold, paying the price to the wallet in `seller-state.SECRET.json`. Resume with `--listing <id> --watch`. To finish the sale with your machine's process closed, hand it to the seller agent:

```sh
node seller.mjs --listing <id> --handoff handoff.SECRET.json
lintel-agent import handoff.SECRET.json && lintel-agent run
```

## Buyer: verify and buy

```sh
node buyer.mjs --listing <id>                          # verify the proof only
node buyer.mjs --listing <id> --buy --funding payin    # prints a ZIP 321 request; pay it from any testnet wallet
node buyer.mjs --listing <id> --buy --wallet-import wallet.json --scan <faucet-txid>
node buyer.mjs --listing <id> --refund                 # only after the lock height, if the seller never settled
```

The decrypted file is written to `<listing>.bin` (or `--out`). Add `--mode relay` to rehearse against a seller running `seller.mjs --watch` without coins.

## AI agent over MCP

```sh
node agent.mjs --want "bug report" --policy policy.example.json
```

Starts `lintel-mcp` over stdio with its own home (`./agent-home`: wallet, policy, spend log, purchases) and runs a scripted agent: list matching listings, verify each proof, buy the cheapest verified one within the owner's limits, poll until unlocked. Before buying on chain, create and fund its wallet: `LINTEL_MCP_HOME=./agent-home npx lintel-mcp wallet create`, then `... wallet scan <txid>`. `LINTEL_MCP_MODE=relay` rehearses without coins. `--llm` (with `ANTHROPIC_API_KEY`) lets Claude drive the same tools. See [docs/agents.md](../docs/agents.md).
