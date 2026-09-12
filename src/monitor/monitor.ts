import type { P2PAd, P2PAdsProvider } from '../services/binanceP2P.types.js';
import type { StateStore } from '../storage/stateStore.js';
import { errorMessage } from '../utils/format.js';
import type { Logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { evaluateAds, markUnseenAsBelow } from './matcher.js';

export interface MonitorOptions {
  provider: P2PAdsProvider;
  store: StateStore;
  logger: Logger;
  pollIntervalMs: number;
  notifiedTtlMs: number;
  maxPages: number;
  /** Threshold used for the Binance request when no user has registered yet. */
  defaultMinRate: number;
  /**
   * Users to evaluate on every check. Users present in the store but not listed here
   * (e.g. removed from the config) are skipped and receive nothing.
   */
  allowedUserIds: readonly number[];
  /** Called per user with ads that crossed *that user's* threshold; must not throw. */
  onNewMatches: (userId: number, ads: P2PAd[], minRate: number) => Promise<void>;
}

export interface UserCheckResult {
  userId: number;
  minRate: number;
  matches: P2PAd[];
  notified: P2PAd[];
}

export interface CheckResult {
  /** All ads returned by Binance, best price first. */
  ads: P2PAd[];
  /** Per-user evaluation; only users registered at the time of the check are present. */
  users: Map<number, UserCheckResult>;
  /** Lowest threshold across users; drove pagination of the Binance request. */
  fetchMinRate: number;
  checkedAt: Date;
}

/**
 * Background polling loop. Independent of Telegram: it keeps running whether or not
 * anyone talks to the bot. One failed check never stops the loop.
 *
 * One Binance request per check serves every user: ads are fetched down to the lowest
 * threshold and then matched against each user's own threshold and ad history.
 */
export class Monitor {
  private readonly log: Logger;
  private readonly abort = new AbortController();
  private loopPromise: Promise<void> | null = null;
  private inFlight: Promise<CheckResult> | null = null;
  private startedAt: Date | null = null;
  private consecutiveFailures = 0;

  constructor(private readonly opts: MonitorOptions) {
    this.log = opts.logger.child({ module: 'monitor' });
  }

  get isRunning(): boolean {
    return this.loopPromise !== null && !this.abort.signal.aborted;
  }

  get uptimeMs(): number {
    return this.startedAt ? Date.now() - this.startedAt.getTime() : 0;
  }

  get pollIntervalMs(): number {
    return this.opts.pollIntervalMs;
  }

  start(): void {
    if (this.loopPromise) return;
    this.startedAt = new Date();
    this.loopPromise = this.loop();
    this.log.info({ pollIntervalMs: this.opts.pollIntervalMs }, 'monitor started');
  }

  async stop(): Promise<void> {
    if (!this.loopPromise) return;
    this.abort.abort();
    await this.loopPromise.catch(() => undefined);
    this.log.info('monitor stopped');
  }

  /**
   * Run a check right now (used by /check). If a scheduled check is already in
   * progress, its result is reused instead of issuing a second request.
   */
  checkNow(): Promise<CheckResult> {
    if (this.inFlight) return this.inFlight;
    const p = this.runCheck().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = p;
    return p;
  }

  private async loop(): Promise<void> {
    const signal = this.abort.signal;
    while (!signal.aborted) {
      let delay = this.opts.pollIntervalMs;
      try {
        await this.checkNow();
        this.consecutiveFailures = 0;
      } catch (err) {
        this.consecutiveFailures++;
        // Back off progressively when Binance keeps failing (max 10x the base interval).
        const factor = Math.min(10, 2 ** Math.min(this.consecutiveFailures - 1, 4));
        delay = this.opts.pollIntervalMs * factor;
        this.log.error(
          {
            err: errorMessage(err),
            consecutiveFailures: this.consecutiveFailures,
            nextCheckInMs: delay,
          },
          'check failed',
        );
      }
      await sleep(delay, signal);
    }
  }

  /** Registered users that are still allowed by the config. */
  private activeUserIds(): number[] {
    const { store, allowedUserIds } = this.opts;
    return allowedUserIds.filter((id) => store.hasUser(id));
  }

  private async runCheck(): Promise<CheckResult> {
    const { store, provider } = this.opts;
    const userIds = this.activeUserIds();
    const fetchMinRate =
      userIds.length > 0
        ? Math.min(...userIds.map((id) => store.getMinRate(id)))
        : this.opts.defaultMinRate;
    const checkedAt = new Date();
    store.updateStats({ totalChecks: store.stats.totalChecks + 1 });

    let ads: P2PAd[];
    try {
      ads = await provider.fetchBuyerAds({
        maxPages: this.opts.maxPages,
        minPrice: fetchMinRate,
        signal: this.abort.signal,
      });
    } catch (err) {
      store.updateStats({
        lastCheckError: errorMessage(err),
        lastCheckErrorAt: checkedAt.toISOString(),
      });
      await store.flushIfDirty();
      throw err;
    }

    const users = new Map<number, UserCheckResult>();
    for (const userId of userIds) {
      const minRate = store.getMinRate(userId);
      const { matches, toNotify, tracks } = evaluateAds(
        ads,
        minRate,
        (id) => store.getAd(userId, id),
        checkedAt,
      );
      for (const [id, track] of tracks) store.setAd(userId, id, track);
      const vanished = markUnseenAsBelow(
        store.adIdsFor(userId),
        new Set(tracks.keys()),
        (id) => store.getAd(userId, id),
        (id, t) => store.setAd(userId, id, t),
      );
      if (vanished.length > 0) {
        this.log.debug({ userId, vanished }, 'matching ads disappeared from results');
      }
      store.updateUser(userId, { lastMatchCount: matches.length });
      users.set(userId, { userId, minRate, matches, notified: toNotify });
    }
    const pruned = store.pruneAds(this.opts.notifiedTtlMs, checkedAt);

    const best = ads[0]?.price ?? null;
    store.updateStats({
      lastSuccessfulCheckAt: checkedAt.toISOString(),
      lastCheckError: null,
      lastAdsCount: ads.length,
      bestPriceSeen:
        best !== null && (store.stats.bestPriceSeen === null || best > store.stats.bestPriceSeen)
          ? best
          : store.stats.bestPriceSeen,
    });

    this.log.info(
      {
        ads: ads.length,
        users: userIds.length,
        fetchMinRate,
        bestPrice: best,
        pruned,
        perUser: [...users.values()].map((u) => ({
          userId: u.userId,
          minRate: u.minRate,
          matches: u.matches.length,
          notify: u.notified.length,
        })),
      },
      'check completed',
    );

    for (const u of users.values()) {
      if (u.notified.length === 0) continue;
      try {
        await this.opts.onNewMatches(u.userId, u.notified, u.minRate);
        store.updateUser(u.userId, {
          totalNotifications:
            (store.getUser(u.userId)?.totalNotifications ?? 0) + u.notified.length,
        });
      } catch (err) {
        // Do not mark as notified for this user, so the next check retries.
        for (const ad of u.notified) {
          const t = store.getAd(u.userId, ad.id);
          if (t)
            store.setAd(u.userId, ad.id, {
              ...t,
              lastAbove: false,
              // Clear the timestamp too, otherwise the retry would hit the re-notify cooldown.
              notifiedAt: null,
              notifyCount: Math.max(0, t.notifyCount - 1),
            });
        }
        this.log.error(
          { userId: u.userId, err: errorMessage(err) },
          'failed to deliver notifications; will retry next check',
        );
      }
    }

    await store.flushIfDirty();
    return { ads, users, fetchMinRate, checkedAt };
  }
}
