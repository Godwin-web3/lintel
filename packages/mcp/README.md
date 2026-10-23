# lintel-mcp

MCP server for [Lintel](https://github.com/Godwin-web3/lintel). An AI agent can browse listings, verify their Halo 2 proofs, and buy or sell sealed data on **Zcash testnet**, under spending limits the owner sets: per-purchase and per-day caps, allowed sellers, allowed listings, expiry. Keys stay in the server and no tool returns them; every purchase attempt is logged.

```sh
lintel-mcp wallet create        # server wallet (fund it from a testnet faucet)
lintel-mcp wallet scan <txid>
cp policy.example.json ~/.lintel-mcp/policy.json
lintel-mcp                      # stdio; or: LINTEL_MCP_HTTP_TOKEN=... lintel-mcp --http 8790
```

Tools: `lintel_list_listings`, `lintel_get_listing`, `lintel_verify_listing`, `lintel_get_limits`, `lintel_spending_report`, `lintel_wallet`, `lintel_wallet_scan`, `lintel_buy`, `lintel_purchase_status`, `lintel_refund`, `lintel_sell`, `lintel_sale_status`, `lintel_handoff_to_agent`.

No policy file means no spending. The limits are enforced by this server, off-chain. Full guide: [docs/agents.md](https://github.com/Godwin-web3/lintel/blob/main/docs/agents.md).

License: MIT OR Apache-2.0.
