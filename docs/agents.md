# Agents (MCP)

`lintel-mcp` lets an AI agent use Lintel through the [Model Context Protocol](https://modelcontextprotocol.io): browse listings, verify their proofs, and buy or sell sealed data on **Zcash testnet**, under spending limits the owner sets and the agent cannot change. Keys stay in the server; every purchase attempt is logged. For selling with no process of your own running, it pairs with the seller agent [`lintel-agent`](cli.md#lintel-agent-seller-agent).

> **Testnet only, unaudited.** The limits are enforced by the server, off-chain (see [What the limits do and don't do](#what-the-limits-do-and-dont-do)).

## Run it

```sh
npm install -g lintel-mcp           # not yet on npm: build packages/mcp from this repo
lintel-mcp wallet create            # the server's testnet wallet; prints its address only
# fund the address from a testnet faucet, then add the payment:
lintel-mcp wallet scan <txid>
cp policy.example.json ~/.lintel-mcp/policy.json && $EDITOR ~/.lintel-mcp/policy.json
lintel-mcp policy check
```

Add it to an MCP client (stdio):

```json
{
  "mcpServers": {
    "lintel": { "command": "lintel-mcp", "env": { "LINTEL_RELAY_URL": "https://lintel-relay.onrender.com" } }
  }
}
```

Sealing a file and the on-chain steps can take minutes (each Halo 2 or Orchard proof runs on one thread). `lintel_purchase_status` and `lintel_sale_status` return after at most `waitSeconds`; give `lintel_sell` and `lintel_buy` a generous tool timeout in your MCP client.

Over HTTP instead (streamable HTTP at `/mcp`, bearer token required, binds to 127.0.0.1 unless `LINTEL_MCP_HTTP_HOST` says otherwise):

```sh
LINTEL_MCP_HTTP_TOKEN=$(openssl rand -hex 24) lintel-mcp --http 8790
```

| Variable | Default | |
| --- | --- | --- |
| `LINTEL_RELAY_URL` | hosted testnet relay | Relay |
| `LINTEL_MCP_HOME` | `~/.lintel-mcp` | Base directory for the files below |
| `LINTEL_MCP_STATE` | `state.json` | SECRET: wallet key, signing shares, adaptor secrets, signed refunds (mode 0600) |
| `LINTEL_MCP_POLICY` | `policy.json` | The owner's limits. Missing or invalid: spending is disabled |
| `LINTEL_MCP_SPEND_LOG` | `spend-log.jsonl` | Every purchase attempt, refusals included (mode 0600) |
| `LINTEL_MCP_OUT` | `purchases/` | Decrypted purchases (mode 0600) |
| `LINTEL_MCP_HANDOFF` | `handoff/` | `lintel-agent` handoff files (SECRET) |
| `LINTEL_MCP_FILES` | unset | Directory `lintel_sell` may read files from; unset means text only |
| `LINTEL_MCP_MODE` | `chain` | `relay` runs purchases as off-chain rehearsals (no funds move) |

## Tools

| Tool | Moves money | |
| --- | --- | --- |
| `lintel_list_listings` | no | Open (or all) listings: title, price, size, status |
| `lintel_get_listing` | no | One listing and where its sale stands (phase, txids) |
| `lintel_verify_listing` | no | Verifies the listing's Halo 2 proof(s) on the server |
| `lintel_get_limits` | no | The owner's limits, spent in the last 24 hours, remaining |
| `lintel_spending_report` | no | The spend log, newest first |
| `lintel_wallet` | no | Wallet address and balance (never the key) |
| `lintel_wallet_scan` | no | Adds a mined payment to the wallet |
| `lintel_buy` | yes | Checks the limits, then starts the purchase (verifies the proof first) |
| `lintel_purchase_status` | yes | Advances a purchase; at `done` saves the content and returns small text inline |
| `lintel_refund` | yes | Broadcasts the co-signed refund after its lock height |
| `lintel_sell` | no | Seals text or an allowed file and lists it (only if the policy allows selling) |
| `lintel_sale_status` | no | Finishes a sale on the server (refund co-signing, settlement) |
| `lintel_handoff_to_agent` | no | Writes a `lintel-agent` handoff file on the server and stops acting on that sale |

## Spending limits

The owner writes `policy.json`; the server reads it fresh on every call, so tightening it needs no restart.

```json
{
  "agent": "research-agent",
  "maxPerPurchaseZec": "0.05",
  "maxPerDayZec": "0.2",
  "allowedSellers": "any",
  "allowedListings": "any",
  "expiresAt": "2026-12-31T23:59:59Z",
  "allowSelling": false
}
```

| Key | |
| --- | --- |
| `maxPerPurchaseZec` | Cap on one purchase's outlay (decimal TAZ) |
| `maxPerDayZec` | Cap on outlays in the rolling 24 hours, this purchase included |
| `allowedSellers` | `"any"` or a list of seller payout addresses (`utest1…`) |
| `allowedListings` | Optional: `"any"` or a list of listing ids |
| `expiresAt` | Optional: no spending after this instant |
| `allowSelling` | Optional, default `false`: whether `lintel_sell` may list anything |

**What is counted.** The outlay, which is what leaves the server's wallet when the escrow is funded: the escrow (price + 20,000 zats), the lock coin (20,000 zats) and the funding fee (15,000 zats). A 0.02 TAZ listing counts as 0.02055 TAZ. Part of it (the lock coin and the escrow's unused fee) comes back after the sale; counting all of it keeps the caps conservative. Purchases that are refused, cancelled before funding, or refunded stop counting.

**When it is checked.**

1. `lintel_buy`: expiry, allowed listings, per-purchase and per-day caps, and the agent's own optional `maxPriceTaz`. A refusal is logged and nothing reaches the relay.
2. Before the funding transaction is built, and again right before it is broadcast (the SDK's `approve` hook): the same checks plus the seller. The relay has no seller accounts; a seller is the payout address it announces in the session, which is the address the settlement must pay (the buyer refuses to sign a settlement paying anyone else). If the seller is not allowed, the purchase is cancelled before any funds move.

Every attempt is a line in the spend log: `reserved`, `funded`, `settled`, `refused`, `released`, `refunded`, with the listing, price, outlay, seller and txids.

### What the limits do and don't do

- They bind the agent because the wallet key exists only in the server's state file and no tool returns it. Anyone with that file, or a shell on that machine, is not bound by them.
- They are not on chain: Zcash does not know about them.
- In `relay` mode (rehearsal) no funds move and the seller check does not apply (no payout address is exchanged).

## Selling with an agent

With `allowSelling: true`, `lintel_sell` seals and lists text, or a file inside `LINTEL_MCP_FILES`. Then either keep the server running and call `lintel_sale_status` (the price goes to the server wallet), or call `lintel_handoff_to_agent` and run the seller agent, which finishes the sale on its own with lightwalletd:

```sh
lintel-agent import ~/.lintel-mcp/handoff/lintel-handoff-<id>.json
lintel-agent run
```

The handoff file holds the listing's secrets; the tool returns its path, never its contents.

## Example

[`examples/agent.mjs`](../examples/agent.mjs) starts `lintel-mcp` over stdio and runs a small scripted agent: list listings matching a keyword, verify each proof, buy the cheapest verified one, poll until it is unlocked. With `--llm` and `ANTHROPIC_API_KEY`, Claude drives the same tools instead.

```sh
cd examples
node agent.mjs --want "bug report" --policy policy.example.json --relay http://localhost:8787
```

## From your own code

The server is also a library: `createServer({ lintel, policyPath, spendLogPath, outDir, handoffDir, mode })` from `lintel-mcp` returns an `McpServer` you can connect to any transport, and `lintel-mcp/policy` exports the pure checks (`parsePolicy`, `checkSpend`). Without MCP, use the SDK's `approve` hook directly ([SDK](sdk.md#purchase)).
