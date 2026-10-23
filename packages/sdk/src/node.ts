// Node entry: WASM and parameters are read from the installed package; state
// can live in a JSON file (FileStore, mode 0600).
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lintel, type LintelOptions } from './lintel.js';
import type { Platform } from './engine.js';
import type { LintelState, StateStore } from './store.js';

export * from './index.js';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export const nodePlatform: Platform = {
  async wasm(kind) {
    return readFile(here(kind === 'core' ? '../wasm/core/lintel_wasm_bg.wasm' : '../wasm/chain/lintel_chain_bg.wasm'));
  },
  async params(kind) {
    return new Uint8Array(await readFile(here(kind === 'v1' ? '../params/params.bin' : '../params/params-big.bin')));
  },
};

/** Creates a client that runs the engine in this Node process. */
export async function createLintel(opts: LintelOptions = {}): Promise<Lintel> {
  return new Lintel(nodePlatform, opts);
}

/**
 * JSON file store. SECRET contents: written with mode 0600, atomically
 * (temp file + rename). Same document shape as the app's localStorage.
 */
export class FileStore implements StateStore {
  constructor(readonly path: string) {}
  async load(): Promise<LintelState | null> {
    try { return JSON.parse(await readFile(this.path, 'utf8')); } catch (e: any) { if (e?.code === 'ENOENT') return null; throw e; }
  }
  async save(s: LintelState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
