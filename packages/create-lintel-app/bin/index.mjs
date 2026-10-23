#!/usr/bin/env node
// npm create lintel-app [dir] [--relay URL]
// Copies the Vite starter, names the package after the directory, and
// writes .env with the relay URL (default: the hosted testnet relay).
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOSTED = 'https://lintel-relay.onrender.com';
const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log('Usage: npm create lintel-app [dir] [-- --relay URL]\n\nScaffolds a Vite app that verifies and buys a Lintel listing on Zcash testnet.');
  process.exit(0);
}
const relayAt = args.indexOf('--relay');
const relay = relayAt >= 0 ? args[relayAt + 1] : HOSTED;
if (!/^https?:\/\/\S+$/.test(relay || '')) { console.error('--relay needs an http(s) URL'); process.exit(1); }
const dirArg = args.find((a, i) => !a.startsWith('-') && (relayAt < 0 || i !== relayAt + 1)) || 'lintel-app';
const dir = resolve(process.cwd(), dirArg);
if (existsSync(dir) && readdirSync(dir).length) { console.error(`${dirArg} exists and is not empty`); process.exit(1); }

const template = fileURLToPath(new URL('../template', import.meta.url));
cpSync(template, dir, { recursive: true });
renameSync(join(dir, 'gitignore'), join(dir, '.gitignore'));
const pkgPath = join(dir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.name = basename(dir).toLowerCase().replace(/[^a-z0-9-~._]+/g, '-').replace(/^[-.]+/, '') || 'lintel-app';
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
writeFileSync(join(dir, '.env'), `VITE_LINTEL_RELAY=${relay}\n`);

console.log(`\nCreated ${dirArg} (relay: ${relay})\n\n  cd ${dirArg}\n  npm install\n  npm run dev\n\nZcash testnet only. Get TAZ from a testnet faucet.`);
