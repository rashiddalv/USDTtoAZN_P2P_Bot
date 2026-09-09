import type { P2PAd, P2PAdsProvider } from '../services/binanceP2P.types.js';
import type { StateStore } from '../storage/stateStore.js';
import { errorMessage } from '../utils/format.js';
import type { Logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { evaluateAds } from './matcher.js';

export interface MonitorOptions {
  provider: P2PAdsProvider;
  store: StateStore;
  logger: Logger;
  pollIntervalMs: number;
  notifiedTtlMs: number;
  maxPages: number;
  /** Called with ads that crossed the threshold; must not throw. */
  onNewMatches: (ads: P2PAd[], minRate: number) => Promise<void>;
}

export interface CheckResult {
  ads: P2PAd[];
  matches: P2PAd[];
  notified: P2PAd[];
  minRate: number;
  checkedAt: Date;
}

/**
 * Background polling loop. Independent of Telegram: it keeps running whether or not
 * anyone talks to the bot. One failed check never stops the loop.
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

  private async runCheck(): Promise<CheckResult> {
    const { store, provider } = this.opts;
    const minRate = store.minRate;
    const checkedAt = new Date();
    store.updateStats({ totalChecks: store.stats.totalChecks + 1 });

    let ads: P2PAd[];
    try {
      ads = await provider.fetchBuyerAds({
        maxPages: this.opts.maxPages,
        minPrice: minRate,
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

    const { matches, toNotify, tracks } = evaluateAds(
      ads,
      minRate,
      (id) => store.getAd(id),
      checkedAt,
    );
    for (const [id, track] of tracks) store.setAd(id, track);
    const pruned = store.pruneAds(this.opts.notifiedTtlMs, checkedAt);

    const best = ads[0]?.price ?? null;
    store.updateStats({
      lastSuccessfulCheckAt: checkedAt.toISOString(),
      lastCheckError: null,
      lastAdsCount: ads.length,
      lastMatchCount: matches.length,
      bestPriceSeen:
        best !== null && (store.stats.bestPriceSeen === null || best > store.stats.bestPriceSeen)
          ? best
          : store.stats.bestPriceSeen,
    });

    this.log.info(
      {
        ads: ads.length,
        matches: matches.length,
        notify: toNotify.length,
        bestPrice: best,
        minRate,
        pruned,
      },
      'check completed',
    );

    if (toNotify.length > 0) {
      try {
        await this.opts.onNewMatches(toNotify, minRate);
        store.updateStats({ totalNotifications: store.stats.totalNotifications + toNotify.length });
      } catch (err) {
        // Do not mark as notified if delivery failed, so the next check retries.
        for (const ad of toNotify) {
          const t = store.getAd(ad.id);
          if (t)
            store.setAd(ad.id, {
              ...t,
              lastAbove: false,
              notifyCount: Math.max(0, t.notifyCount - 1),
            });
        }
        this.log.error(
          { err: errorMessage(err) },
          'failed to deliver notifications; will retry next check',
        );
      }
    }

    await store.flushIfDirty();
    return { ads, matches, notified: toNotify, minRate, checkedAt };
  }
}
