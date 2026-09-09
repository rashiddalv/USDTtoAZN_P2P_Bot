import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../utils/logger.js';

/** Per-ad tracking used for de-duplication and "crossed the threshold" detection. */
export interface AdTrack {
  lastPrice: number;
  /** Whether the ad satisfied the threshold at the last check. */
  lastAbove: boolean;
  /** ISO timestamp of the last time the ad was seen in Binance results. */
  lastSeenAt: string;
  /** ISO timestamp of the last notification sent for this ad. */
  notifiedAt: string | null;
  notifyCount: number;
}

export interface MonitorStats {
  lastSuccessfulCheckAt: string | null;
  lastCheckError: string | null;
  lastCheckErrorAt: string | null;
  totalChecks: number;
  totalNotifications: number;
  /** Ads returned by Binance on the last successful check. */
  lastAdsCount: number;
  /** Ads that matched the threshold on the last successful check. */
  lastMatchCount: number;
  bestPriceSeen: number | null;
}

export interface PersistedState {
  version: 1;
  settings: { minRate: number };
  ads: Record<string, AdTrack>;
  stats: MonitorStats;
}

export function defaultState(minRate: number): PersistedState {
  return {
    version: 1,
    settings: { minRate },
    ads: {},
    stats: {
      lastSuccessfulCheckAt: null,
      lastCheckError: null,
      lastCheckErrorAt: null,
      totalChecks: 0,
      totalNotifications: 0,
      lastAdsCount: 0,
      lastMatchCount: 0,
      bestPriceSeen: null,
    },
  };
}

/**
 * Tiny persistent JSON store with atomic writes (write temp file + rename).
 * Good enough for a single-process bot; swap for a DB if the app grows.
 */
export class StateStore {
  private state: PersistedState;
  private readonly filePath: string;
  private readonly log: Logger;
  private writeChain: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(
    dataDir: string,
    private readonly defaultMinRate: number,
    logger: Logger,
  ) {
    this.filePath = path.join(dataDir, 'state.json');
    this.log = logger.child({ module: 'state-store' });
    this.state = defaultState(defaultMinRate);
  }

  get path(): string {
    return this.filePath;
  }

  async load(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      this.state = this.migrate(parsed);
      this.log.info(
        {
          path: this.filePath,
          minRate: this.state.settings.minRate,
          trackedAds: Object.keys(this.state.ads).length,
        },
        'state loaded',
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.log.info({ path: this.filePath }, 'no existing state, starting fresh');
        await this.flush();
        return;
      }
      this.log.error({ err, path: this.filePath }, 'failed to read state, starting fresh');
      this.state = defaultState(this.defaultMinRate);
    }
  }

  private migrate(parsed: unknown): PersistedState {
    const fresh = defaultState(this.defaultMinRate);
    if (typeof parsed !== 'object' || parsed === null) return fresh;
    const p = parsed as Partial<PersistedState>;
    const minRate = p.settings?.minRate;
    return {
      version: 1,
      settings: {
        minRate: typeof minRate === 'number' && minRate > 0 ? minRate : fresh.settings.minRate,
      },
      ads: typeof p.ads === 'object' && p.ads !== null ? p.ads : {},
      stats: { ...fresh.stats, ...(p.stats ?? {}) },
    };
  }

  // ---- settings ----

  get minRate(): number {
    return this.state.settings.minRate;
  }

  setMinRate(rate: number): void {
    this.state.settings.minRate = rate;
    this.markDirty();
  }

  // ---- stats ----

  get stats(): Readonly<MonitorStats> {
    return this.state.stats;
  }

  updateStats(patch: Partial<MonitorStats>): void {
    Object.assign(this.state.stats, patch);
    this.markDirty();
  }

  // ---- ads ----

  getAd(id: string): AdTrack | undefined {
    return this.state.ads[id];
  }

  setAd(id: string, track: AdTrack): void {
    this.state.ads[id] = track;
    this.markDirty();
  }

  get trackedAdCount(): number {
    return Object.keys(this.state.ads).length;
  }

  /** Remove ads not seen for longer than `ttlMs`. Returns number removed. */
  pruneAds(ttlMs: number, now: Date = new Date()): number {
    const cutoff = now.getTime() - ttlMs;
    let removed = 0;
    for (const [id, track] of Object.entries(this.state.ads)) {
      const seen = Date.parse(track.lastSeenAt);
      if (Number.isNaN(seen) || seen < cutoff) {
        delete this.state.ads[id];
        removed++;
      }
    }
    if (removed > 0) this.markDirty();
    return removed;
  }

  // ---- persistence ----

  private markDirty(): void {
    this.dirty = true;
  }

  /** Persist to disk if anything changed. Writes are serialized. */
  flush(): Promise<void> {
    this.dirty = false;
    const snapshot = JSON.stringify(this.state, null, 2);
    this.writeChain = this.writeChain
      .then(async () => {
        const tmp = `${this.filePath}.${process.pid}.tmp`;
        await writeFile(tmp, snapshot, 'utf8');
        await rename(tmp, this.filePath);
      })
      .catch((err: unknown) => {
        this.dirty = true;
        this.log.error({ err, path: this.filePath }, 'failed to persist state');
      });
    return this.writeChain;
  }

  /** Persist only if there are unsaved changes. */
  flushIfDirty(): Promise<void> {
    return this.dirty ? this.flush() : this.writeChain;
  }
}
