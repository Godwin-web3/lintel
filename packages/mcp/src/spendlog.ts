/**
 * Every spend the agent attempts, refused ones included, as JSON lines in a
 * file the owner can read (mode 0600). The rolling 24-hour total is computed
 * from it, so a restart does not reset the daily cap.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type SpendStatus =
  | 'refused' // policy said no; nothing happened
  | 'reserved' // purchase started; counted against the cap
  | 'funded' // funding broadcast
  | 'settled' // content unlocked
  | 'refunded' // refund broadcast (no longer counted)
  | 'released'; // abandoned before funding (no longer counted)

export interface SpendEntry {
  at: string;
  id: string; // purchase id (listing id)
  status: SpendStatus;
  listing: string;
  title?: string;
  price_zats?: number;
  outlay_zats?: number;
  seller?: string | null;
  reason?: string;
  txid?: string;
}

/** Statuses whose outlay counts against the daily cap (latest entry per purchase). */
export const COUNTED: SpendStatus[] = ['reserved', 'funded', 'settled'];
export const DAY_MS = 24 * 60 * 60 * 1000;

export class SpendLog {
  constructor(readonly path: string) {}

  append(e: Omit<SpendEntry, 'at'> & { at?: string }): SpendEntry {
    const full = { at: e.at ?? new Date().toISOString(), ...e } as SpendEntry;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, JSON.stringify(full) + '\n', { mode: 0o600 });
    return full;
  }

  entries(): SpendEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  /** Latest entry of each purchase. */
  latest(): Map<string, SpendEntry & { started: string; outlay: number }> {
    const out = new Map<string, SpendEntry & { started: string; outlay: number }>();
    for (const e of this.entries()) {
      if (e.status === 'refused') continue;
      const prev = out.get(e.id);
      out.set(e.id, { ...prev, ...e, started: prev?.started ?? e.at, outlay: e.outlay_zats ?? prev?.outlay ?? 0 });
    }
    return out;
  }

  /** Counted outlay of purchases started in the last 24 hours, excluding `except`. */
  spentSince(now: Date = new Date(), except?: string): number {
    let sum = 0;
    for (const [id, e] of this.latest()) {
      if (id === except || !COUNTED.includes(e.status)) continue;
      if (now.getTime() - Date.parse(e.started) < DAY_MS) sum += e.outlay;
    }
    return sum;
  }

  /** The current status of one purchase, if any. */
  status(id: string): SpendStatus | null { return this.latest().get(id)?.status ?? null; }
}
