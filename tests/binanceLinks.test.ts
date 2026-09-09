import { describe, expect, it } from 'vitest';
import {
  advertiserAppUrl,
  advertiserWebUrl,
  buildAppLink,
  marketAppUrl,
  marketWebUrl,
  webviewDeepLinkPath,
} from '../src/services/binanceLinks.js';

const decode = (s: string) => Buffer.from(s, 'base64').toString('utf8');

describe('binanceLinks', () => {
  it('builds web links on p2p.binance.com', () => {
    expect(advertiserWebUrl('abc')).toBe(
      'https://p2p.binance.com/en/advertiserDetail?advertiserNo=abc',
    );
    expect(marketWebUrl('USDT', 'AZN', 'sell')).toBe(
      'https://p2p.binance.com/en/trade/sell/USDT?fiat=AZN&payment=all-payments',
    );
  });

  it('encodes the same two-layer _dp format Binance uses on its own pages', () => {
    // Reference sample captured from p2p.binance.com on 2026-09-09.
    const sample =
      'L3dlYnZpZXcvd2Vidmlldz90eXBlPWRlZmF1bHQmdXJsPWFIUjBjSE02THk5M2QzY3VZbWx1WVc1alpTNWpiMjB2ZTJ4aGJtZDlMMjVsZHkxMWMyVnlMWHB2Ym1V';
    const link = buildAppLink(
      webviewDeepLinkPath('https://www.binance.com/{lang}/new-user-zone'),
      '/new-user-zone',
    );
    expect(link).toBe(`https://app.binance.com/new-user-zone?_dp=${sample}`);
  });

  it('app links decode back to the advertiser / market web URLs', () => {
    const url = new URL(advertiserAppUrl('u1'));
    expect(url.origin).toBe('https://app.binance.com');
    expect(url.pathname).toBe('/en/advertiserDetail');
    expect(url.searchParams.get('advertiserNo')).toBe('u1');
    const dp = decode(url.searchParams.get('_dp')!);
    expect(dp.startsWith('/webview/webview?type=default&url=')).toBe(true);
    expect(decode(dp.split('url=')[1]!)).toBe(advertiserWebUrl('u1'));

    const m = new URL(marketAppUrl('USDT', 'AZN', 'sell'));
    expect(decode(decode(m.searchParams.get('_dp')!).split('url=')[1]!)).toBe(
      marketWebUrl('USDT', 'AZN', 'sell'),
    );
  });

  it('produces http(s) URLs acceptable for Telegram inline buttons', () => {
    for (const u of [advertiserAppUrl('x'), marketAppUrl('USDT', 'AZN', 'sell')]) {
      expect(u.startsWith('https://')).toBe(true);
      expect(u).not.toContain('=&');
    }
  });
});
