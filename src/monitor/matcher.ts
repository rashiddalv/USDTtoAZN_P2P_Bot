import type { P2PAd } from '../services/binanceP2P.types.js';
import type { AdTrack } from '../storage/stateStore.js';

export function matchesThreshold(ad: P2PAd, minRate: number): boolean {
  return ad.price >= minRate;
}

export interface EvaluationResult {
  /** Ads that satisfy the threshold right now. */
  matches: P2PAd[];
  /** Subset of `matches` that should trigger a notification. */
  toNotify: P2PAd[];
  /** Updated tracks for every ad seen in this check (to be persisted). */
  tracks: Map<string, AdTrack>;
}

/**
 * Minimum time between two notifications for the same ad, unless its price improved.
 * Guards against an ad that flickers in and out of the result page every few seconds.
 */
export const RENOTIFY_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Pure de-duplication logic:
 *  - notify when an ad matches and we have never seen it, or
 *  - it matches now but did NOT match at the previous check (crossed the threshold upwards,
 *    or came back after disappearing - see `markUnseenAsBelow`).
 * An ad that keeps matching check after check is never re-sent. A re-notification within
 * `renotifyCooldownMs` of the previous one is suppressed unless the price got better.
 */
export function evaluateAds(
  ads: P2PAd[],
  minRate: number,
  getTrack: (id: string) => AdTrack | undefined,
  now: Date = new Date(),
  renotifyCooldownMs = RENOTIFY_COOLDOWN_MS,
): EvaluationResult {
  const nowIso = now.toISOString();
  const matches: P2PAd[] = [];
  const toNotify: P2PAd[] = [];
  const tracks = new Map<string, AdTrack>();

  for (const ad of ads) {
    const above = matchesThreshold(ad, minRate);
    const prev = getTrack(ad.id);
    const crossed = above && (prev === undefined || !prev.lastAbove);
    const lastNotified = prev?.notifiedAt ? Date.parse(prev.notifiedAt) : NaN;
    const recentlyNotified =
      Number.isFinite(lastNotified) && now.getTime() - lastNotified < renotifyCooldownMs;
    const improved = prev !== undefined && ad.price > prev.lastPrice;
    const suppressed = crossed && recentlyNotified && !improved;
    const shouldNotify = crossed && !suppressed;

    if (above) matches.push(ad);
    if (shouldNotify) toNotify.push(ad);

    tracks.set(ad.id, {
      lastPrice: ad.price,
      // A crossing suppressed by the cooldown stays "pending": once the cooldown is over and
      // the ad is still good, the next check will send it.
      lastAbove: above && !suppressed,
      lastSeenAt: nowIso,
      notifiedAt: shouldNotify ? nowIso : (prev?.notifiedAt ?? null),
      notifyCount: (prev?.notifyCount ?? 0) + (shouldNotify ? 1 : 0),
    });
  }

  matches.sort((a, b) => b.price - a.price);
  toNotify.sort((a, b) => b.price - a.price);
  return { matches, toNotify, tracks };
}

/**
 * An ad that vanished from the results (sold out, paused, deleted, or pushed off the page)
 * must count as "below the threshold": when it comes back at a good price the user wants to
 * hear about it again. Returns the ids whose `lastAbove` flag was cleared.
 */
export function markUnseenAsBelow(
  trackedIds: Iterable<string>,
  seen: ReadonlySet<string>,
  getTrack: (id: string) => AdTrack | undefined,
  setTrack: (id: string, track: AdTrack) => void,
): string[] {
  const cleared: string[] = [];
  for (const id of trackedIds) {
    if (seen.has(id)) continue;
    const t = getTrack(id);
    if (t && t.lastAbove) {
      setTrack(id, { ...t, lastAbove: false });
      cleared.push(id);
    }
  }
  return cleared;
}
