#!/usr/bin/env node
// AI-agent example: an agent buys sealed data through lintel-mcp, under the
// owner's spending limits. The agent never sees a key: lintel-mcp holds the
// wallet and signs; the agent only calls tools.
//
// Two drivers:
//   * scripted (default): a small deterministic planner. Lists open
//     listings matching --want, verifies each proof, picks the cheapest
//     verified one, buys it and polls until it is unlocked.
//   * --llm (needs ANTHROPIC_API_KEY): Claude drives the same MCP tools.
//
//   node agent.mjs --want "bug report" --policy policy.json
//   LINTEL_MCP_MODE=relay node agent.mjs --want demo   # off-chain rehearsal (no funds move)
//
// --relay URL      relay for lintel-mcp (default: LINTEL_RELAY_URL or the hosted testnet relay)
// --home DIR       lintel-mcp home: state, policy, spend log, purchases (default ./agent-home)
// --policy FILE    owner's policy (copied to the home if given)
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseArgs, log } from './args.mjs';

const a = parseArgs();
const home = resolve(a.home || 'agent-home');
mkdirSync(home, { recursive: true, mode: 0o700 });
if (a.policy) copyFileSync(a.policy, join(home, 'policy.json'));
const bin = createRequire(import.meta.url).resolve('lintel-mcp/package.json').replace(/package\.json$/, 'dist/index.js');

const transport = new StdioClientTransport({
  command: process.execPath, args: [bin],
  env: { ...process.env, LINTEL_MCP_HOME: home, ...(a.relay ? { LINTEL_RELAY_URL: a.relay } : {}) },
  stderr: 'inherit',
});
const client = new Client({ name: 'lintel-example-agent', version: '0.1.0' });
await client.connect(transport);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 15 * 60 * 1000 }); // proving can take minutes
  const out = JSON.parse(r.content[0].text);
  if (r.isError) throw new Error(`${name}: ${out.error}`);
  return out;
};

try {
  if (a.llm) await llm(String(a.want || 'something useful'));
  else await scripted(String(a.want || ''));
} finally {
  await client.close();
}

async function scripted(want) {
  const limits = await call('lintel_get_limits');
  log('limits', JSON.stringify(limits));
  if (limits.spending !== 'enabled') { log('owner has not enabled spending; browsing only'); }
  const { listings } = await call('lintel_list_listings', { status: 'open' });
  const candidates = listings.filter((l) => l.kind === 'single copy' && `${l.title} ${l.description}`.toLowerCase().includes(want.toLowerCase()));
  log(`${candidates.length} open listing(s) match "${want}"`);
  const verified = [];
  for (const l of candidates) {
    const v = await call('lintel_verify_listing', { listingId: l.id });
    log(`${v.verified ? 'verified' : 'REJECTED'} ${l.id} "${l.title}" ${l.price_taz} TAZ${v.verified ? ` (${v.kind}, ${v.ms} ms)` : `: ${v.error}`}`);
    if (v.verified) verified.push(l);
  }
  if (!verified.length || limits.spending !== 'enabled') return;
  const pick = verified.sort((x, y) => Number(x.price_taz) - Number(y.price_taz))[0];
  log(`buying ${pick.id} "${pick.title}" for ${pick.price_taz} TAZ`);
  let s;
  try { s = await call('lintel_buy', { listingId: pick.id, maxPriceTaz: pick.price_taz, waitSeconds: 30 }); }
  catch (e) { log(`refused: ${e.message}`); return; }
  while (!s.refused && s.phase !== 'done') {
    log(`[${s.phase}] ${s.note}`);
    s = await call('lintel_purchase_status', { listingId: pick.id, waitSeconds: 60 });
  }
  if (s.refused) { log(`refused before funding: ${s.reason}`); return; }
  log(`unlocked ${s.bytes} bytes -> ${s.saved_to}`);
  if (s.content) log(`content: ${s.content.slice(0, 500)}`);
  if (s.txids?.settlement) log(`settlement txid ${s.txids.settlement}`);
  log('spending report', JSON.stringify((await call('lintel_spending_report')).spent_last_24h_taz), 'TAZ in the last 24 h');
}

// Claude drives the MCP tools (Anthropic Messages API, tool use). Untested in CI: needs ANTHROPIC_API_KEY.
async function llm(want) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('--llm needs ANTHROPIC_API_KEY');
  const { tools } = await client.listTools();
  const spec = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const messages = [{ role: 'user', content: `Find and buy sealed data on Lintel (Zcash testnet) matching: "${want}". Always verify a listing's proof before buying, check the spending limits first, and stop if a purchase is refused. Poll lintel_purchase_status until the phase is "done", then summarise what you bought.` }];
  for (let turn = 0; turn < 40; turn++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5', max_tokens: 2048, tools: spec, messages }),
    });
    const msg = await res.json();
    if (!res.ok) throw new Error(msg.error?.message || `Anthropic API ${res.status}`);
    messages.push({ role: 'assistant', content: msg.content });
    for (const b of msg.content) if (b.type === 'text') log(`agent: ${b.text}`);
    const uses = msg.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) return;
    const results = [];
    for (const u of uses) {
      log(`tool ${u.name} ${JSON.stringify(u.input)}`);
      const r = await client.callTool({ name: u.name, arguments: u.input }, undefined, { timeout: 15 * 60 * 1000 });
      results.push({ type: 'tool_result', tool_use_id: u.id, content: r.content[0].text, is_error: !!r.isError });
    }
    messages.push({ role: 'user', content: results });
  }
}
