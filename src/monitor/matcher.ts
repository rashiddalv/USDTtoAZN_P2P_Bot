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
 * Pure de-duplication logic:
 *  - notify when an ad matches and we have never seen it, or
 *  - it matches now but did NOT match at the previous check (crossed the threshold upwards).
 * An ad that keeps matching check after check is never re-sent.
 */
export function evaluateAds(
  ads: P2PAd[],
  minRate: number,
  getTrack: (id: string) => AdTrack | undefined,
  now: Date = new Date(),
): EvaluationResult {
  const nowIso = now.toISOString();
  const matches: P2PAd[] = [];
  const toNotify: P2PAd[] = [];
  const tracks = new Map<string, AdTrack>();

  for (const ad of ads) {
    const above = matchesThreshold(ad, minRate);
    const prev = getTrack(ad.id);
    const shouldNotify = above && (prev === undefined || !prev.lastAbove);

    if (above) matches.push(ad);
    if (shouldNotify) toNotify.push(ad);

    tracks.set(ad.id, {
      lastPrice: ad.price,
      lastAbove: above,
      lastSeenAt: nowIso,
      notifiedAt: shouldNotify ? nowIso : (prev?.notifiedAt ?? null),
      notifyCount: (prev?.notifyCount ?? 0) + (shouldNotify ? 1 : 0),
    });
  }

  matches.sort((a, b) => b.price - a.price);
  toNotify.sort((a, b) => b.price - a.price);
  return { matches, toNotify, tracks };
}
