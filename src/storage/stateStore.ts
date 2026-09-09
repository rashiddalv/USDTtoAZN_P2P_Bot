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

/** Everything that is specific to one Telegram user. */
export interface UserState {
  /** Minimum acceptable rate (fiat per 1 asset) for this user. */
  minRate: number;
  /** Ad tracks keyed by ad id. Kept per user because "crossed the threshold" depends on the threshold. */
  ads: Record<string, AdTrack>;
  /** ISO timestamp of the first interaction with the bot. */
  firstSeenAt: string;
  totalNotifications: number;
  /** Ads that matched this user's threshold on the last successful check. */
  lastMatchCount: number;
}

/** Stats that are shared by all users (one Binance check serves everyone). */
export interface MonitorStats {
  lastSuccessfulCheckAt: string | null;
  lastCheckError: string | null;
  lastCheckErrorAt: string | null;
  totalChecks: number;
  /** Ads returned by Binance on the last successful check. */
  lastAdsCount: number;
  bestPriceSeen: number | null;
}

export interface PersistedState {
  version: 2;
  users: Record<string, UserState>;
  stats: MonitorStats;
}

/** Shape of the pre-multi-user state file, kept only for migration. */
interface PersistedStateV1 {
  version?: 1;
  settings?: { minRate?: number };
  ads?: Record<string, AdTrack>;
  stats?: Partial<MonitorStats> & { totalNotifications?: number; lastMatchCount?: number };
}

export function defaultStats(): MonitorStats {
  return {
    lastSuccessfulCheckAt: null,
    lastCheckError: null,
    lastCheckErrorAt: null,
    totalChecks: 0,
    lastAdsCount: 0,
    bestPriceSeen: null,
  };
}

export function defaultUserState(minRate: number, now: Date = new Date()): UserState {
  return {
    minRate,
    ads: {},
    firstSeenAt: now.toISOString(),
    totalNotifications: 0,
    lastMatchCount: 0,
  };
}

export function defaultState(): PersistedState {
  return { version: 2, users: {}, stats: defaultStats() };
}

export interface StateStoreOptions {
  /** Threshold assigned to a user the first time they are seen. */
  defaultMinRate: number;
  /**
   * User who inherits the settings of a v1 (single-user) state file.
   * Normally the first configured user id, i.e. the original owner of the bot.
   */
  primaryUserId?: number | undefined;
}

/**
 * Tiny persistent JSON store with atomic writes (write temp file + rename).
 * Good enough for a single-process bot; swap for a DB if the app grows.
 */
export class StateStore {
  private state: PersistedState = defaultState();
  private readonly filePath: string;
  private readonly log: Logger;
  private readonly defaultMinRate: number;
  private readonly primaryUserId: number | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(dataDir: string, opts: StateStoreOptions, logger: Logger) {
    this.filePath = path.join(dataDir, 'state.json');
    this.log = logger.child({ module: 'state-store' });
    this.defaultMinRate = opts.defaultMinRate;
    this.primaryUserId = opts.primaryUserId;
  }

  get path(): string {
    return this.filePath;
  }

  async load(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const { state, migrated } = this.migrate(parsed);
      this.state = state;
      this.log.info(
        {
          path: this.filePath,
          users: this.userIds().length,
          trackedAds: this.trackedAdCount,
          migrated,
        },
        'state loaded',
      );
      if (migrated) await this.flush();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.log.info({ path: this.filePath }, 'no existing state, starting fresh');
        await this.flush();
        return;
      }
      this.log.error({ err, path: this.filePath }, 'failed to read state, starting fresh');
      this.state = defaultState();
    }
  }

  private migrate(parsed: unknown): { state: PersistedState; migrated: boolean } {
    if (typeof parsed !== 'object' || parsed === null) {
      return { state: defaultState(), migrated: false };
    }
    const version = (parsed as { version?: unknown }).version;
    if (version === 2) return { state: this.normalizeV2(parsed), migrated: false };
    return { state: this.migrateV1(parsed), migrated: true };
  }

  private normalizeV2(p: Partial<PersistedState>): PersistedState {
    const users: Record<string, UserState> = {};
    for (const [id, u] of Object.entries(p.users ?? {})) {
      if (typeof u !== 'object' || u === null) continue;
      const fresh = defaultUserState(this.defaultMinRate);
      users[id] = {
        ...fresh,
        ...u,
        minRate: isValidRate(u.minRate) ? u.minRate : fresh.minRate,
        ads: typeof u.ads === 'object' && u.ads !== null ? u.ads : {},
      };
    }
    return { version: 2, users, stats: { ...defaultStats(), ...(p.stats ?? {}) } };
  }

  /** v1 kept one threshold and one ad list; hand them over to the primary user. */
  private migrateV1(p: PersistedStateV1): PersistedState {
    const state: PersistedState = { version: 2, users: {}, stats: defaultStats() };
    const s = p.stats ?? {};
    state.stats = {
      lastSuccessfulCheckAt: s.lastSuccessfulCheckAt ?? null,
      lastCheckError: s.lastCheckError ?? null,
      lastCheckErrorAt: s.lastCheckErrorAt ?? null,
      totalChecks: s.totalChecks ?? 0,
      lastAdsCount: s.lastAdsCount ?? 0,
      bestPriceSeen: s.bestPriceSeen ?? null,
    };
    if (this.primaryUserId !== undefined) {
      const minRate = p.settings?.minRate;
      state.users[String(this.primaryUserId)] = {
        ...defaultUserState(isValidRate(minRate) ? minRate : this.defaultMinRate),
        ads: typeof p.ads === 'object' && p.ads !== null ? p.ads : {},
        totalNotifications: s.totalNotifications ?? 0,
        lastMatchCount: s.lastMatchCount ?? 0,
      };
      this.log.info({ userId: this.primaryUserId }, 'migrated single-user state to v2');
    } else {
      this.log.warn('v1 state found but no primary user configured; per-user settings dropped');
    }
    return state;
  }

  // ---- users ----

  userIds(): number[] {
    return Object.keys(this.state.users).map(Number);
  }

  hasUser(userId: number): boolean {
    return String(userId) in this.state.users;
  }

  getUser(userId: number): Readonly<UserState> | undefined {
    return this.state.users[String(userId)];
  }

  /** Returns the user's state, creating it with the default threshold on first sight. */
  ensureUser(userId: number, now: Date = new Date()): Readonly<UserState> {
    const key = String(userId);
    let user = this.state.users[key];
    if (!user) {
      user = defaultUserState(this.defaultMinRate, now);
      this.state.users[key] = user;
      this.markDirty();
      this.log.info({ userId, minRate: user.minRate }, 'new user registered');
    }
    return user;
  }

  removeUser(userId: number): boolean {
    const key = String(userId);
    if (!(key in this.state.users)) return false;
    delete this.state.users[key];
    this.markDirty();
    return true;
  }

  private mutableUser(userId: number): UserState {
    const user = this.state.users[String(userId)];
    if (!user) throw new Error(`unknown user ${userId}`);
    return user;
  }

  // ---- settings ----

  getMinRate(userId: number): number {
    return this.mutableUser(userId).minRate;
  }

  setMinRate(userId: number, rate: number): void {
    this.mutableUser(userId).minRate = rate;
    this.markDirty();
  }

  /** Lowest threshold across all users, or undefined when there are no users. */
  lowestMinRate(): number | undefined {
    const rates = Object.values(this.state.users).map((u) => u.minRate);
    return rates.length > 0 ? Math.min(...rates) : undefined;
  }

  // ---- stats ----

  get stats(): Readonly<MonitorStats> {
    return this.state.stats;
  }

  updateStats(patch: Partial<MonitorStats>): void {
    Object.assign(this.state.stats, patch);
    this.markDirty();
  }

  updateUser(
    userId: number,
    patch: Partial<Pick<UserState, 'totalNotifications' | 'lastMatchCount'>>,
  ): void {
    Object.assign(this.mutableUser(userId), patch);
    this.markDirty();
  }

  // ---- ads ----

  getAd(userId: number, adId: string): AdTrack | undefined {
    return this.state.users[String(userId)]?.ads[adId];
  }

  setAd(userId: number, adId: string, track: AdTrack): void {
    this.mutableUser(userId).ads[adId] = track;
    this.markDirty();
  }

  /** Tracked ads across all users (an ad seen by two users counts twice). */
  get trackedAdCount(): number {
    let n = 0;
    for (const u of Object.values(this.state.users)) n += Object.keys(u.ads).length;
    return n;
  }

  trackedAdCountFor(userId: number): number {
    return Object.keys(this.state.users[String(userId)]?.ads ?? {}).length;
  }

  /** Remove ads (for every user) not seen for longer than `ttlMs`. Returns number removed. */
  pruneAds(ttlMs: number, now: Date = new Date()): number {
    const cutoff = now.getTime() - ttlMs;
    let removed = 0;
    for (const user of Object.values(this.state.users)) {
      for (const [id, track] of Object.entries(user.ads)) {
        const seen = Date.parse(track.lastSeenAt);
        if (Number.isNaN(seen) || seen < cutoff) {
          delete user.ads[id];
          removed++;
        }
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

function isValidRate(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}
