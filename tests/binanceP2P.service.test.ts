import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { BinanceP2PError, BinanceP2PService } from '../src/services/binanceP2P.service.js';
import { RetryableError } from '../src/utils/retry.js';

const logger = pino({ level: 'silent' });

function rawItem(advNo: string, price: string, tradeType = 'BUY') {
  return {
    adv: {
      advNo,
      tradeType,
      asset: 'USDT',
      fiatUnit: 'AZN',
      price,
      surplusAmount: '39.47',
      tradableQuantity: '39.47',
      minSingleTransAmount: '50',
      maxSingleTransAmount: '34000',
      dynamicMaxSingleTransAmount: '65',
      payTimeLimit: 60,
      tradeMethods: [
        {
          identifier: 'azInstantM10',
          tradeMethodName: 'M10 - Instant',
          tradeMethodShortName: 'M10 - Instant',
        },
        { identifier: 'KapitalBank', tradeMethodName: 'Kapital Bank Instant' },
      ],
    },
    advertiser: {
      userNo: 'sc0a1c647d7f13206b4edde5a949f0d8d',
      nickName: 'CryptoV0id',
      userType: 'user',
      monthOrderCount: 92,
      monthFinishRate: 0.969,
      positiveRate: 0.984,
    },
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function makeService(fetchFn: typeof fetch, retryAttempts = 3) {
  return new BinanceP2PService({
    asset: 'USDT',
    fiat: 'AZN',
    timeoutMs: 5_000,
    retryAttempts,
    logger,
    fetchFn,
  });
}

describe('BinanceP2PService', () => {
  it('sends tradeType=SELL and normalizes ads from counterparties who BUY', async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        tradeType: string;
        asset: string;
        fiat: string;
      };
      expect(body.tradeType).toBe('SELL');
      expect(body.asset).toBe('USDT');
      expect(body.fiat).toBe('AZN');
      return jsonResponse({
        code: '000000',
        success: true,
        total: 1,
        data: [rawItem('1', '1.67')],
      });
    });
    const ads = await makeService(fetchFn as unknown as typeof fetch).fetchBuyerAds();
    expect(ads).toHaveLength(1);
    const ad = ads[0]!;
    expect(ad.id).toBe('1');
    expect(ad.price).toBe(1.67);
    expect(ad.availableAsset).toBe(39.47);
    expect(ad.minFiat).toBe(50);
    expect(ad.maxFiat).toBe(65);
    expect(ad.paymentMethods).toEqual(['M10 - Instant', 'Kapital Bank Instant']);
    expect(ad.advertiser.nickName).toBe('CryptoV0id');
    expect(ad.advertiser.completionRate).toBeCloseTo(0.969);
    expect(ad.advertiser.monthOrderCount).toBe(92);
    expect(ad.advertiserUrl).toContain(
      'advertiserDetail?advertiserNo=sc0a1c647d7f13206b4edde5a949f0d8d',
    );
    expect(ad.marketUrl).toContain('/trade/sell/USDT?fiat=AZN');
  });

  it('skips ads with unexpected side or malformed shape', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        code: '000000',
        data: [
          rawItem('ok', '1.70'),
          rawItem('wrong-side', '1.80', 'SELL'),
          { adv: {}, advertiser: {} },
          null,
        ],
      }),
    );
    const ads = await makeService(fetchFn as unknown as typeof fetch).fetchBuyerAds();
    expect(ads.map((a) => a.id)).toEqual(['ok']);
  });

  it('paginates while ads still satisfy minPrice', async () => {
    const page1 = Array.from({ length: 20 }, (_, i) => rawItem(`p1-${i}`, '1.75'));
    const page2 = [rawItem('p2-0', '1.72'), rawItem('p2-1', '1.60')];
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { page: number };
      return jsonResponse({ code: '000000', data: body.page === 1 ? page1 : page2 });
    });
    const ads = await makeService(fetchFn as unknown as typeof fetch).fetchBuyerAds({
      maxPages: 5,
      minPrice: 1.7,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(ads).toHaveLength(22);
    expect(ads[0]!.price).toBe(1.75);
    expect(ads.at(-1)!.price).toBe(1.6);
  });

  it('retries on 5xx and succeeds', async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls++;
      if (calls < 3) return new Response('bad gateway', { status: 502 });
      return jsonResponse({ code: '000000', data: [rawItem('1', '1.71')] });
    });
    const service = makeService(fetchFn as unknown as typeof fetch);
    // Speed up: patch Math.random so jitter is ~0
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0);
    const ads = await service.fetchBuyerAds();
    rnd.mockRestore();
    expect(calls).toBe(3);
    expect(ads).toHaveLength(1);
  });

  it('enters cooldown on 429 and refuses requests until it expires', async () => {
    const fetchFn = vi.fn(
      async () => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }),
    );
    const service = makeService(fetchFn as unknown as typeof fetch, 1);
    await expect(service.fetchBuyerAds()).rejects.toBeInstanceOf(RetryableError);
    expect(service.cooldownRemainingMs).toBeGreaterThan(100_000);
    await expect(service.fetchBuyerAds()).rejects.toThrow(/cooldown/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('throws a non-retryable error on API error code', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ code: '100001', message: 'invalid fiat' }));
    await expect(
      makeService(fetchFn as unknown as typeof fetch).fetchBuyerAds(),
    ).rejects.toBeInstanceOf(BinanceP2PError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('treats request timeout as retryable', async () => {
    const fetchFn = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const service = new BinanceP2PService({
      asset: 'USDT',
      fiat: 'AZN',
      timeoutMs: 1_000,
      retryAttempts: 1,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(service.fetchBuyerAds()).rejects.toThrow(/timed out/);
  });
});
