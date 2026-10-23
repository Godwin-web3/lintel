// Browser entry: the WASM glue fetches its .wasm next to itself; parameters
// are fetched next to the package (bundlers emit them as assets). Override
// with createLintel({ paramsBase }) to serve them yourself, e.g. from the
// hosted app: their digests are pinned in the WASM, so any source is safe.
import { Lintel, type LintelOptions } from './lintel.js';
import type { Platform } from './engine.js';

export * from './index.js';

export interface BrowserOptions extends LintelOptions {
  /** Base URL that serves params.bin and params-big.bin. Default: bundled with the package. */
  paramsBase?: string;
}

async function fetchBytes(url: string | URL): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load ${String(url)} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

export function browserPlatform(paramsBase?: string): Platform {
  const base = paramsBase?.replace(/\/$/, '');
  return {
    async wasm() { return undefined; },
    async params(kind) {
      if (base) return fetchBytes(`${base}/${kind === 'v1' ? 'params.bin' : 'params-big.bin'}`);
      return fetchBytes(kind === 'v1' ? new URL('../params/params.bin', import.meta.url) : new URL('../params/params-big.bin', import.meta.url));
    },
  };
}

/** Creates a client that runs the engine on this page (use a Worker for heavy sealing). */
export async function createLintel(opts: BrowserOptions = {}): Promise<Lintel> {
  return new Lintel(browserPlatform(opts.paramsBase), opts);
}
