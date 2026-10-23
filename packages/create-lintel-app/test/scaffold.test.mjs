import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/index.mjs', import.meta.url));

test('scaffolds the template with package name, .gitignore and relay .env', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  const out = execFileSync(process.execPath, [BIN, 'My App', '--relay', 'http://localhost:8787'], { cwd, encoding: 'utf8' });
  assert.match(out, /Created My App/);
  const dir = path.join(cwd, 'My App');
  for (const f of ['package.json', 'index.html', 'vite.config.ts', 'tsconfig.json', 'src/main.ts', 'src/style.css', '.gitignore', '.env', 'README.md']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.ok(!fs.existsSync(path.join(dir, 'gitignore')));
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'my-app');
  assert.ok(pkg.dependencies['lintel-sdk']);
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'VITE_LINTEL_RELAY=http://localhost:8787\n');
});

test('refuses a non-empty directory and a bad relay URL', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  fs.mkdirSync(path.join(cwd, 'x')); fs.writeFileSync(path.join(cwd, 'x', 'f'), '1');
  assert.throws(() => execFileSync(process.execPath, [BIN, 'x'], { cwd, stdio: 'pipe' }));
  assert.throws(() => execFileSync(process.execPath, [BIN, 'y', '--relay', 'ftp://nope'], { cwd, stdio: 'pipe' }));
});
