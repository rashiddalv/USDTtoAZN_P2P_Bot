/**
 * Link builders for Binance P2P.
 *
 * Two kinds of links are produced for every ad:
 *
 *  1. Web link (`p2p.binance.com`) — always works in a browser.
 *
 *  2. App link (`app.binance.com/...?_dp=...`) — Binance's universal-link domain.
 *     Verified on 2026-09-09:
 *       - iOS  `https://app.binance.com/.well-known/apple-app-site-association`
 *         declares `paths: ["*"]` for the Binance app (p2p.binance.com only
 *         declares `/oauth/authorize`, so plain web links stay in Safari).
 *       - Android `assetlinks.json` on app/www/p2p.binance.com all declare
 *         `handle_all_urls` for `com.binance.dev`.
 *     The `_dp` query parameter carries a base64-encoded in-app deep link.
 *     The generic `/webview/webview?type=default&url=<base64 url>` route opens
 *     any Binance page inside the app's (logged-in) webview. This is the same
 *     format Binance itself embeds on p2p.binance.com and documents for
 *     Binance Pay (`https://app.binance.com/payment/secpay?_dp=...`).
 *     Without the app installed the link falls back to www.binance.com.
 */

export const P2P_WEB_ORIGIN = 'https://p2p.binance.com';
export const APP_LINK_ORIGIN = 'https://app.binance.com';

function b64(input: string): string {
  // Binance uses standard base64 without padding for both layers.
  return Buffer.from(input, 'utf8').toString('base64').replace(/=+$/, '');
}

/** Wrap any Binance web URL into an in-app deep link path. */
export function webviewDeepLinkPath(url: string): string {
  return `/webview/webview?type=default&url=${b64(url)}`;
}

/**
 * Build a universal link that opens the Binance app (when installed) and
 * navigates it to `deepLinkPath`. `fallbackPath` is what a desktop browser sees.
 */
export function buildAppLink(deepLinkPath: string, fallbackPath = '/en/p2p'): string {
  const sep = fallbackPath.includes('?') ? '&' : '?';
  return `${APP_LINK_ORIGIN}${fallbackPath}${sep}_dp=${b64(deepLinkPath)}`;
}

export function advertiserWebUrl(userNo: string, lang = 'en'): string {
  return `${P2P_WEB_ORIGIN}/${lang}/advertiserDetail?advertiserNo=${encodeURIComponent(userNo)}`;
}

export function marketWebUrl(
  asset: string,
  fiat: string,
  side: 'buy' | 'sell',
  lang = 'en',
): string {
  return `${P2P_WEB_ORIGIN}/${lang}/trade/${side}/${encodeURIComponent(asset)}?fiat=${encodeURIComponent(fiat)}&payment=all-payments`;
}

export function advertiserAppUrl(userNo: string): string {
  const web = advertiserWebUrl(userNo);
  return buildAppLink(
    webviewDeepLinkPath(web),
    `/en/advertiserDetail?advertiserNo=${encodeURIComponent(userNo)}`,
  );
}

export function marketAppUrl(asset: string, fiat: string, side: 'buy' | 'sell'): string {
  const web = marketWebUrl(asset, fiat, side);
  return buildAppLink(
    webviewDeepLinkPath(web),
    `/en/trade/${side}/${encodeURIComponent(asset)}?fiat=${encodeURIComponent(fiat)}`,
  );
}
