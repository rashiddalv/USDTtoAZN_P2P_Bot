/**
 * Manual probe: fetch live USDT/AZN "I sell USDT" ads from Binance P2P without Telegram.
 * Usage: npm run probe  (optional env ASSET/FIAT/MIN_RATE)
 */
import { BinanceP2PService } from '../src/services/binanceP2P.service.js';
import { createLogger } from '../src/utils/logger.js';

const asset = process.env.ASSET ?? 'USDT';
const fiat = process.env.FIAT ?? 'AZN';
const minRate = Number(process.env.MIN_RATE ?? '1.70');

const service = new BinanceP2PService({
  asset,
  fiat,
  timeoutMs: 15_000,
  retryAttempts: 3,
  logger: createLogger('warn', 'pretty'),
});

const ads = await service.fetchBuyerAds({ maxPages: 2, minPrice: minRate });
console.log(
  `Fetched ${ads.length} ads where counterparties BUY ${asset} for ${fiat} (you SELL ${asset}).`,
);
console.log(`Threshold ${minRate}: ${ads.filter((a) => a.price >= minRate).length} match.\n`);
for (const ad of ads.slice(0, 10)) {
  console.log(
    `${ad.price.toFixed(4)} ${fiat} | avail ${ad.availableAsset} ${asset} | ${ad.minFiat}-${ad.maxFiat} ${fiat} | ` +
      `${ad.advertiser.nickName} | ${((ad.advertiser.completionRate ?? 0) * 100).toFixed(1)}% | ` +
      `${ad.advertiser.monthOrderCount ?? 'n/a'} trades | ${ad.paymentMethods.join('/')} | ${ad.advertiserUrl}`,
  );
}
