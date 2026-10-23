#!/usr/bin/env node
/**
 * lintel-mcp CLI.
 *
 *   lintel-mcp                      MCP over stdio (default)
 *   lintel-mcp --http 8790          MCP over streamable HTTP at /mcp (needs LINTEL_MCP_HTTP_TOKEN)
 *   lintel-mcp wallet create        create the server wallet (prints its address only)
 *   lintel-mcp wallet show          address + balance
 *   lintel-mcp wallet scan <txid>   add a faucet payment
 *   lintel-mcp policy check         validate the policy file
 *
 * Environment (defaults under ~/.lintel-mcp):
 *   LINTEL_RELAY_URL       relay (default: hosted testnet relay)
 *   LINTEL_MCP_STATE       SECRET keys + purchase state (state.json, 0600)
 *   LINTEL_MCP_POLICY      owner's spending policy (policy.json); missing = no spending
 *   LINTEL_MCP_SPEND_LOG   JSON-lines spend log (spend-log.jsonl)
 *   LINTEL_MCP_OUT         decrypted purchases (purchases/)
 *   LINTEL_MCP_HANDOFF     lintel-agent handoff files (handoff/)
 *   LINTEL_MCP_FILES       directory lintel_sell may read files from (unset: text only)
 *   LINTEL_MCP_MODE        chain (default) | relay (off-chain rehearsal, no funds move)
 */
import { createServer as createHttpServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createLintel, FileStore, fmtZec } from 'lintel-sdk';
import { createServer, type ServerConfig } from './server.js';
import { loadPolicy } from './policy.js';

const env = process.env;
const home = env.LINTEL_MCP_HOME || join(homedir(), '.lintel-mcp');
const args = process.argv.slice(2);

async function config(): Promise<ServerConfig> {
  const lintel = await createLintel({ relayUrl: env.LINTEL_RELAY_URL, store: new FileStore(env.LINTEL_MCP_STATE || join(home, 'state.json')) });
  if (env.LINTEL_MCP_CREATE_WALLET === '1' && !(await lintel.wallet.address())) await lintel.wallet.create();
  const mode = env.LINTEL_MCP_MODE === 'relay' ? 'relay' : 'chain';
  return {
    lintel, mode,
    policyPath: env.LINTEL_MCP_POLICY || join(home, 'policy.json'),
    spendLogPath: env.LINTEL_MCP_SPEND_LOG || join(home, 'spend-log.jsonl'),
    outDir: env.LINTEL_MCP_OUT || join(home, 'purchases'),
    handoffDir: env.LINTEL_MCP_HANDOFF || join(home, 'handoff'),
    filesDir: env.LINTEL_MCP_FILES || undefined,
  };
}

async function main() {
  const cfg = await config();
  if (args[0] === 'wallet') {
    const w = cfg.lintel.wallet;
    if (args[1] === 'create') { console.log(await w.create()); return; }
    if (args[1] === 'scan' && args[2]) { const f = await w.scan(args[2]); console.log(`found ${f.length} note(s); balance ${fmtZec(await w.balance())} TAZ`); return; }
    const info = await w.info();
    console.log(info ? `${info.address}\nbalance ${fmtZec(info.balance)} TAZ` : 'no wallet (lintel-mcp wallet create)');
    return;
  }
  if (args[0] === 'policy') {
    const p = loadPolicy(cfg.policyPath, (f) => readFileSync(f, 'utf8'));
    console.log(p.mode === 'enforced' ? `ok: ${p.source}` : p.reason);
    process.exitCode = p.mode === 'enforced' ? 0 : 1;
    return;
  }
  const httpAt = args.indexOf('--http');
  if (httpAt >= 0) {
    const port = Number(args[httpAt + 1] || 8790);
    const token = env.LINTEL_MCP_HTTP_TOKEN;
    if (!token || token.length < 24) throw new Error('set LINTEL_MCP_HTTP_TOKEN (24+ chars) to serve over HTTP');
    const host = env.LINTEL_MCP_HTTP_HOST || '127.0.0.1';
    const ok = (h?: string) => { const a = Buffer.from(h || ''), b = Buffer.from(`Bearer ${token}`); return a.length === b.length && timingSafeEqual(a, b); };
    createHttpServer(async (req, res) => {
      if (new URL(req.url || '/', 'http://x').pathname !== '/mcp') { res.writeHead(404).end(); return; }
      if (!ok(req.headers.authorization)) { res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end(); return; }
      // stateless: a fresh server + transport per request, sharing the same Lintel state
      const server = createServer(cfg);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    }).listen(port, host, () => console.error(`lintel-mcp on http://${host}:${port}/mcp (${cfg.mode}, relay ${cfg.lintel.relay.url})`));
    return;
  }
  const server = createServer(cfg);
  await server.connect(new StdioServerTransport());
  console.error(`lintel-mcp on stdio (${cfg.mode}, relay ${cfg.lintel.relay.url})`);
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
