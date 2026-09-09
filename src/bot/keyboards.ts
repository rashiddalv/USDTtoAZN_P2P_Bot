import { InlineKeyboard } from 'grammy';
import type { P2PAd } from '../services/binanceP2P.types.js';
import { marketAppUrl, marketWebUrl } from '../services/binanceLinks.js';
import { formatNumber } from '../utils/format.js';

/** Callback data identifiers. Kept short: Telegram limits callback_data to 64 bytes. */
export const CB = {
  menu: 'menu',
  check: 'check',
  status: 'status',
  help: 'help',
  rateMenu: 'rate:menu',
  rateDelta: 'rate:d:', // + signed delta, e.g. rate:d:-0.005
  rateSet: 'rate:s:', // + absolute value, e.g. rate:s:1.7
} as const;

export const RATE_PRESETS = [1.66, 1.67, 1.68, 1.69, 1.7, 1.71, 1.72, 1.75];
export const RATE_DELTAS = [-0.01, -0.005, 0.005, 0.01];

export function mainMenuKeyboard(asset: string, fiat: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔍 Проверить сейчас', CB.check)
    .row()
    .text('📡 Статус', CB.status)
    .text('⚙️ Порог', CB.rateMenu)
    .row()
    .url('📱 Binance P2P в приложении', marketAppUrl(asset, fiat, 'sell'))
    .row()
    .url('🌐 Binance P2P в браузере', marketWebUrl(asset, fiat, 'sell'))
    .text('❓ Помощь', CB.help);
}

export function backToMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('◀️ Меню', CB.menu);
}

export function rateMenuKeyboard(current: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const d of RATE_DELTAS) {
    kb.text(
      `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(3).replace(/0+$/, '')}`,
      `${CB.rateDelta}${d}`,
    );
  }
  kb.row();
  RATE_PRESETS.forEach((p, i) => {
    const label = Math.abs(p - current) < 1e-9 ? `• ${formatNumber(p, 3)} •` : formatNumber(p, 3);
    kb.text(label, `${CB.rateSet}${p}`);
    if (i % 4 === 3) kb.row();
  });
  kb.text('◀️ Меню', CB.menu);
  return kb;
}

export function statusKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔄 Обновить', CB.status)
    .text('🔍 Проверить', CB.check)
    .row()
    .text('⚙️ Порог', CB.rateMenu)
    .text('◀️ Меню', CB.menu);
}

export function alertKeyboard(ad: P2PAd): InlineKeyboard {
  return new InlineKeyboard()
    .url('📱 Открыть в приложении Binance', ad.advertiserAppUrl)
    .row()
    .url('🌐 В браузере', ad.advertiserUrl)
    .url('📋 Все объявления', ad.marketAppUrl)
    .row()
    .text('🔍 Проверить ещё раз', CB.check)
    .text('📡 Статус', CB.status);
}

/** One button per ad so the user can jump straight to a trader from the /check list. */
export function checkResultKeyboard(ads: P2PAd[], asset: string, fiat: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  ads.forEach((ad, i) => {
    kb.url(
      `${i + 1} · ${formatNumber(ad.price, 4)} · ${truncate(ad.advertiser.nickName, 14)}`,
      ad.advertiserAppUrl,
    );
    kb.row();
  });
  kb.url('📋 Все объявления', marketAppUrl(asset, fiat, 'sell')).row();
  kb.text('🔄 Обновить', CB.check).text('◀️ Меню', CB.menu);
  return kb;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
