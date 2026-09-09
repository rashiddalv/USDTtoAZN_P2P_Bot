/**
 * Types for the Binance P2P web endpoint
 *   POST https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search
 *
 * NOTE: this is the endpoint used by the p2p.binance.com web UI, not an officially
 * documented public API. Only fields we actually rely on are typed strictly; the rest
 * are optional so that upstream changes do not break parsing.
 */

/**
 * Trade side as seen from the *requesting user's* perspective.
 *  - "SELL": the user wants to sell the asset -> returned ads are from counterparties who BUY it.
 *  - "BUY":  the user wants to buy the asset  -> returned ads are from counterparties who SELL it.
 *
 * Verified empirically on 2026-09-09 for USDT/AZN: request tradeType=SELL returns ads
 * with adv.tradeType="BUY" (prices 1.66-1.67), request tradeType=BUY returns ads with
 * adv.tradeType="SELL" (prices 1.68-1.69).
 */
export type P2PTradeSide = 'BUY' | 'SELL';

export interface BinanceP2PSearchRequest {
  asset: string;
  fiat: string;
  tradeType: P2PTradeSide;
  page: number;
  rows: number;
  payTypes: string[];
  publisherType: null | 'merchant';
  countries?: string[];
  proMerchantAds?: boolean;
  shieldMerchantAds?: boolean;
  filterType?: 'all' | 'tradable';
  transAmount?: string;
}

export interface BinanceP2PTradeMethod {
  identifier?: string | null;
  payType?: string | null;
  tradeMethodName?: string | null;
  tradeMethodShortName?: string | null;
}

export interface BinanceP2PAdv {
  advNo: string;
  /** Side of the *advertiser* (opposite to the request tradeType). */
  tradeType: P2PTradeSide;
  asset: string;
  fiatUnit: string;
  fiatSymbol?: string | null;
  /** Decimal string, e.g. "1.67" */
  price: string;
  /** Available asset amount, decimal string */
  surplusAmount?: string | null;
  tradableQuantity?: string | null;
  /** Fiat limits (decimal strings) */
  minSingleTransAmount?: string | null;
  maxSingleTransAmount?: string | null;
  dynamicMaxSingleTransAmount?: string | null;
  payTimeLimit?: number | null;
  isTradable?: boolean | null;
  tradeMethods?: BinanceP2PTradeMethod[] | null;
}

export interface BinanceP2PAdvertiser {
  userNo: string;
  nickName: string;
  userType?: string | null;
  monthOrderCount?: number | null;
  /** 0..1 */
  monthFinishRate?: number | null;
  /** 0..1 */
  positiveRate?: number | null;
  userGrade?: number | null;
  proMerchant?: boolean | null;
  isBlocked?: boolean | null;
}

export interface BinanceP2PAdItem {
  adv: BinanceP2PAdv;
  advertiser: BinanceP2PAdvertiser;
}

export interface BinanceP2PSearchResponse {
  code: string;
  message?: string | null;
  messageDetail?: string | null;
  data?: BinanceP2PAdItem[] | null;
  total?: number | null;
  success?: boolean;
}

/** Normalized, provider-agnostic representation used by the rest of the app. */
export interface P2PAd {
  id: string;
  asset: string;
  fiat: string;
  /** Fiat per 1 unit of asset */
  price: number;
  availableAsset: number;
  minFiat: number;
  maxFiat: number;
  payTimeLimitMin: number | null;
  advertiser: {
    userNo: string;
    nickName: string;
    completionRate: number | null;
    positiveRate: number | null;
    monthOrderCount: number | null;
    isMerchant: boolean;
  };
  paymentMethods: string[];
  /** Web link to the advertiser page on Binance P2P */
  advertiserUrl: string;
  /** Universal link that opens the advertiser page inside the Binance app */
  advertiserAppUrl: string;
  /** Web link to the market list on Binance P2P for this pair/side */
  marketUrl: string;
  /** Universal link that opens the market list inside the Binance app */
  marketAppUrl: string;
}

/** Abstraction so the Binance integration can be swapped for another provider. */
export interface P2PAdsProvider {
  /**
   * Returns ads from counterparties who BUY `asset` for `fiat`
   * (i.e. the user SELLS the asset), sorted best price first.
   */
  fetchBuyerAds(opts?: {
    maxPages?: number;
    minPrice?: number;
    signal?: AbortSignal | undefined;
  }): Promise<P2PAd[]>;
}
