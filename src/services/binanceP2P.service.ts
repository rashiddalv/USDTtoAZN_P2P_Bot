import type { Logger } from '../utils/logger.js';
import { RetryableError, withRetry } from '../utils/retry.js';
import { advertiserAppUrl, advertiserWebUrl, marketAppUrl, marketWebUrl } from './binanceLinks.js';
import type {
  BinanceP2PAdItem,
  BinanceP2PSearchRequest,
  BinanceP2PSearchResponse,
  P2PAd,
  P2PAdsProvider,
  P2PTradeSide,
} from './binanceP2P.types.js';

/**
 * Binance P2P integration.
 *
 * Uses the web-UI endpoint (NOT an official public API):
 *   POST https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search
 *
 * Everything endpoint-specific lives in this file, so replacing it
 * only requires implementing `P2PAdsProvider` differently.
 */

export const BINANCE_P2P_SEARCH_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
const PAGE_SIZE = 20;

export interface BinanceP2PServiceOptions {
  asset: string;
  fiat: string;
  timeoutMs: number;
  retryAttempts: number;
  logger: Logger;
  /** Override for tests. */
  fetchFn?: typeof fetch;
  /** Override for tests. */
  url?: string;
}

export class BinanceP2PError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'BinanceP2PError';
  }
}

export class BinanceP2PService implements P2PAdsProvider {
  private readonly log: Logger;
  private readonly fetchFn: typeof fetch;
  private readonly url: string;
  /** Until this timestamp, requests are refused locally (set after a 429). */
  private cooldownUntil = 0;

  constructor(private readonly opts: BinanceP2PServiceOptions) {
    this.log = opts.logger.child({ module: 'binance-p2p' });
    this.fetchFn = opts.fetchFn ?? fetch;
    this.url = opts.url ?? BINANCE_P2P_SEARCH_URL;
  }

  get asset(): string {
    return this.opts.asset;
  }

  get fiat(): string {
    return this.opts.fiat;
  }

  /** Remaining cooldown in ms after a rate-limit response, 0 if none. */
  get cooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - Date.now());
  }

  /**
   * Ads from counterparties who BUY the asset (so that we can SELL it).
   * Binance returns them sorted by price descending (best for the seller first),
   * so we keep paginating only while the last ad still satisfies `minPrice`.
   */
  async fetchBuyerAds(
    opts: { maxPages?: number; minPrice?: number; signal?: AbortSignal | undefined } = {},
  ): Promise<P2PAd[]> {
    const maxPages = Math.max(1, opts.maxPages ?? 1);
    const result: P2PAd[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= maxPages; page++) {
      const items = await this.search({ tradeType: 'SELL', page, signal: opts.signal });
      const ads = items
        .map((item) => this.normalize(item))
        .filter((ad): ad is P2PAd => ad !== null);

      for (const ad of ads) {
        if (!seen.has(ad.id)) {
          seen.add(ad.id);
          result.push(ad);
        }
      }

      const last = ads.at(-1);
      const pageFull = items.length >= PAGE_SIZE;
      const stillInteresting =
        opts.minPrice === undefined || (last !== undefined && last.price >= opts.minPrice);
      if (!pageFull || !stillInteresting) break;
    }

    result.sort((a, b) => b.price - a.price);
    return result;
  }

  /** Raw search with timeout, retry/backoff and 429 cooldown. */
  async search(params: {
    tradeType: P2PTradeSide;
    page: number;
    signal?: AbortSignal | undefined;
  }): Promise<BinanceP2PAdItem[]> {
    const cooldown = this.cooldownRemainingMs;
    if (cooldown > 0) {
      throw new RetryableError(
        `Binance rate-limit cooldown active for ${Math.ceil(cooldown / 1000)}s`,
        cooldown,
      );
    }

    const body: BinanceP2PSearchRequest = {
      asset: this.opts.asset,
      fiat: this.opts.fiat,
      tradeType: params.tradeType,
      page: params.page,
      rows: PAGE_SIZE,
      payTypes: [],
      publisherType: null,
    };

    return withRetry(
      async (attempt) => {
        this.log.debug({ page: params.page, attempt }, 'requesting Binance P2P ads');
        const response = await this.request(body, params.signal);
        this.log.debug({ page: params.page, count: response.length }, 'received Binance P2P ads');
        return response;
      },
      {
        attempts: this.opts.retryAttempts,
        baseDelayMs: 1_000,
        maxDelayMs: 20_000,
        signal: params.signal,
        onRetry: (err, attempt, delay) =>
          this.log.warn(
            { attempt, delayMs: delay, err: errToString(err) },
            'Binance request failed, retrying',
          ),
      },
    );
  }

  private async request(
    body: BinanceP2PSearchRequest,
    signal?: AbortSignal,
  ): Promise<BinanceP2PAdItem[]> {
    const timeoutSignal = AbortSignal.timeout(this.opts.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          Origin: 'https://p2p.binance.com',
          Referer: 'https://p2p.binance.com/',
        },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      if (timeoutSignal.aborted)
        throw new RetryableError(`Binance request timed out after ${this.opts.timeoutMs}ms`);
      throw new RetryableError(`Network error: ${errToString(err)}`);
    }

    if (res.status === 429) {
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after')) ?? 60_000;
      this.cooldownUntil = Date.now() + retryAfterMs;
      this.log.warn({ retryAfterMs }, 'Binance responded 429 Too Many Requests, entering cooldown');
      throw new RetryableError('Binance rate limit (429)', retryAfterMs);
    }
    if (res.status === 403 || res.status === 451) {
      // WAF / geo-block: retrying immediately will not help, but the next poll may succeed.
      throw new BinanceP2PError(`Binance refused the request (HTTP ${res.status})`);
    }
    if (res.status >= 500) {
      throw new RetryableError(`Binance server error (HTTP ${res.status})`);
    }
    if (!res.ok) {
      throw new BinanceP2PError(`Unexpected HTTP status ${res.status}`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new RetryableError(`Invalid JSON from Binance: ${errToString(err)}`);
    }
    return this.parseResponse(json);
  }

  private parseResponse(json: unknown): BinanceP2PAdItem[] {
    if (!isRecord(json)) throw new BinanceP2PError('Response is not an object');
    const resp = json as Partial<BinanceP2PSearchResponse>;

    if (resp.code !== '000000' || resp.success === false) {
      const msg = resp.message ?? resp.messageDetail ?? 'unknown error';
      throw new BinanceP2PError(
        `Binance API error ${String(resp.code)}: ${msg}`,
        String(resp.code),
      );
    }
    if (resp.data === null || resp.data === undefined) return [];
    if (!Array.isArray(resp.data)) throw new BinanceP2PError('Response "data" is not an array');

    const items: BinanceP2PAdItem[] = [];
    for (const raw of resp.data) {
      if (isAdItem(raw)) items.push(raw);
      else
        this.log.warn({ raw: truncate(JSON.stringify(raw)) }, 'skipping ad with unexpected shape');
    }
    return items;
  }

  /** Convert a raw Binance item into the provider-agnostic `P2PAd`. Returns null if unusable. */
  normalize(item: BinanceP2PAdItem): P2PAd | null {
    const { adv, advertiser } = item;
    const price = toNumber(adv.price);
    if (price === null || price <= 0) {
      this.log.warn({ advNo: adv.advNo, price: adv.price }, 'ad has invalid price, skipping');
      return null;
    }
    if (adv.tradeType !== 'BUY') {
      // Defensive: we asked for counterparties who BUY; anything else means the endpoint semantics changed.
      this.log.warn(
        { advNo: adv.advNo, tradeType: adv.tradeType },
        'unexpected adv.tradeType, skipping',
      );
      return null;
    }

    const available = toNumber(adv.tradableQuantity) ?? toNumber(adv.surplusAmount) ?? 0;
    const minFiat = toNumber(adv.minSingleTransAmount) ?? 0;
    const maxFiat =
      toNumber(adv.dynamicMaxSingleTransAmount) ?? toNumber(adv.maxSingleTransAmount) ?? 0;

    const paymentMethods = (adv.tradeMethods ?? [])
      .map((m) => m.tradeMethodShortName ?? m.tradeMethodName ?? m.identifier ?? m.payType ?? '')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    return {
      id: adv.advNo,
      asset: adv.asset,
      fiat: adv.fiatUnit,
      price,
      availableAsset: available,
      minFiat,
      maxFiat,
      payTimeLimitMin: typeof adv.payTimeLimit === 'number' ? adv.payTimeLimit : null,
      advertiser: {
        userNo: advertiser.userNo,
        nickName: advertiser.nickName,
        completionRate:
          typeof advertiser.monthFinishRate === 'number' ? advertiser.monthFinishRate : null,
        positiveRate: typeof advertiser.positiveRate === 'number' ? advertiser.positiveRate : null,
        monthOrderCount:
          typeof advertiser.monthOrderCount === 'number' ? advertiser.monthOrderCount : null,
        isMerchant: advertiser.userType === 'merchant' || advertiser.proMerchant === true,
      },
      paymentMethods,
      advertiserUrl: advertiserWebUrl(advertiser.userNo),
      advertiserAppUrl: advertiserAppUrl(advertiser.userNo),
      marketUrl: marketWebUrl(adv.asset, adv.fiatUnit, 'sell'),
      marketAppUrl: marketAppUrl(adv.asset, adv.fiatUnit, 'sell'),
    };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isAdItem(v: unknown): v is BinanceP2PAdItem {
  if (!isRecord(v) || !isRecord(v.adv) || !isRecord(v.advertiser)) return false;
  const adv = v.adv;
  const advertiser = v.advertiser;
  return (
    typeof adv.advNo === 'string' &&
    typeof adv.price === 'string' &&
    typeof adv.tradeType === 'string' &&
    typeof adv.asset === 'string' &&
    typeof adv.fiatUnit === 'string' &&
    typeof advertiser.userNo === 'string' &&
    typeof advertiser.nickName === 'string'
  );
}

function toNumber(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

function truncate(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function errToString(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
