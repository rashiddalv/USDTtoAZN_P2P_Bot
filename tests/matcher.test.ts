import { describe, expect, it } from 'vitest';
import { evaluateAds } from '../src/monitor/matcher.js';
import type { P2PAd } from '../src/services/binanceP2P.types.js';
import type { AdTrack } from '../src/storage/stateStore.js';

function ad(id: string, price: number): P2PAd {
  return {
    id,
    asset: 'USDT',
    fiat: 'AZN',
    price,
    availableAsset: 100,
    minFiat: 50,
    maxFiat: 500,
    payTimeLimitMin: 15,
    advertiser: {
      userNo: `u-${id}`,
      nickName: `nick-${id}`,
      completionRate: 0.99,
      positiveRate: 0.98,
      monthOrderCount: 10,
      isMerchant: false,
    },
    paymentMethods: ['M10'],
    advertiserUrl: 'https://example.test/a',
    advertiserAppUrl: 'https://example.test/app-a',
    marketUrl: 'https://example.test/m',
    marketAppUrl: 'https://example.test/app-m',
  };
}

describe('evaluateAds', () => {
  it('notifies new ads above threshold, sorted best first', () => {
    const res = evaluateAds([ad('a', 1.69), ad('b', 1.71), ad('c', 1.705)], 1.7, () => undefined);
    expect(res.matches.map((a) => a.id)).toEqual(['b', 'c']);
    expect(res.toNotify.map((a) => a.id)).toEqual(['b', 'c']);
    expect(res.tracks.get('a')?.lastAbove).toBe(false);
    expect(res.tracks.get('b')?.notifyCount).toBe(1);
  });

  it('does not re-notify an ad that keeps matching', () => {
    const first = evaluateAds([ad('a', 1.71)], 1.7, () => undefined);
    const second = evaluateAds([ad('a', 1.72)], 1.7, (id) => first.tracks.get(id));
    expect(second.matches).toHaveLength(1);
    expect(second.toNotify).toHaveLength(0);
    expect(second.tracks.get('a')?.notifyCount).toBe(1);
    expect(second.tracks.get('a')?.notifiedAt).toBe(first.tracks.get('a')?.notifiedAt);
  });

  it('re-notifies when an ad crosses the threshold from below', () => {
    const t1 = evaluateAds([ad('a', 1.71)], 1.7, () => undefined);
    const t2 = evaluateAds([ad('a', 1.68)], 1.7, (id) => t1.tracks.get(id));
    expect(t2.toNotify).toHaveLength(0);
    expect(t2.tracks.get('a')?.lastAbove).toBe(false);
    const t3 = evaluateAds([ad('a', 1.7)], 1.7, (id) => t2.tracks.get(id));
    expect(t3.toNotify.map((a) => a.id)).toEqual(['a']);
    expect(t3.tracks.get('a')?.notifyCount).toBe(2);
  });

  it('threshold is inclusive', () => {
    const res = evaluateAds([ad('a', 1.7)], 1.7, () => undefined);
    expect(res.toNotify).toHaveLength(1);
  });

  it('lowering the rate notifies ads that newly qualify only', () => {
    const t1 = evaluateAds([ad('a', 1.71), ad('b', 1.66)], 1.7, () => undefined);
    const prev = (id: string): AdTrack | undefined => t1.tracks.get(id);
    const t2 = evaluateAds([ad('a', 1.71), ad('b', 1.66)], 1.65, prev);
    expect(t2.toNotify.map((a) => a.id)).toEqual(['b']);
  });
});
