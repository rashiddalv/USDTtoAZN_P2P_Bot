import type { P2PAd } from '../services/binanceP2P.types.js';
import type { MonitorStats } from '../storage/stateStore.js';
import {
  escapeHtml,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
} from '../utils/format.js';

export interface StatusInfo {
  running: boolean;
  minRate: number;
  asset: string;
  fiat: string;
  pollIntervalMs: number;
  uptimeMs: number;
  stats: MonitorStats;
  trackedAds: number;
  cooldownMs: number;
  timezone: string;
}

export function adAlertMessage(ad: P2PAd): string {
  return [
    '🔔 <b>Binance P2P — найден хороший курс</b>',
    '',
    `💵 1 ${escapeHtml(ad.asset)} = <b>${formatNumber(ad.price, 4)} ${escapeHtml(ad.fiat)}</b>`,
    `💰 Доступно: ${formatNumber(ad.availableAsset)} ${escapeHtml(ad.asset)}`,
    `📊 Лимиты: ${formatNumber(ad.minFiat)}–${formatNumber(ad.maxFiat)} ${escapeHtml(ad.fiat)}`,
    '',
    `👤 ${escapeHtml(ad.advertiser.nickName)}${ad.advertiser.isMerchant ? ' ✔️' : ''}`,
    `✅ Completion: ${formatPercent(ad.advertiser.completionRate)}`,
    `🔄 Trades (30d): ${ad.advertiser.monthOrderCount ?? 'n/a'}`,
    `🏦 ${escapeHtml(ad.paymentMethods.join(' / ') || 'n/a')}`,
    ad.payTimeLimitMin ? `⏱ Оплата: ${ad.payTimeLimitMin} мин` : null,
    '',
    `<code>${escapeHtml(ad.id)}</code>`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

export function adShortLine(ad: P2PAd, index: number): string {
  return [
    `${index}. <b>${formatNumber(ad.price, 4)} ${escapeHtml(ad.fiat)}</b> — ${escapeHtml(ad.advertiser.nickName)}`,
    `   💰 ${formatNumber(ad.availableAsset)} ${escapeHtml(ad.asset)} · 📊 ${formatNumber(ad.minFiat)}–${formatNumber(ad.maxFiat)} ${escapeHtml(ad.fiat)}`,
    `   ✅ ${formatPercent(ad.advertiser.completionRate)} · 🔄 ${ad.advertiser.monthOrderCount ?? 'n/a'} · 🏦 ${escapeHtml(ad.paymentMethods.join(' / ') || 'n/a')}`,
    `   <a href="${ad.advertiserUrl}">Открыть</a>`,
  ].join('\n');
}

export function checkResultMessage(
  ads: P2PAd[],
  matches: P2PAd[],
  minRate: number,
  asset: string,
  fiat: string,
  topN: number,
): string {
  if (ads.length === 0) {
    return `⚠️ Binance не вернул ни одного объявления для ${asset}/${fiat}.`;
  }
  const best = ads[0];
  const header = [
    `🔍 <b>Проверка ${escapeHtml(asset)}/${escapeHtml(fiat)}</b> (продажа ${escapeHtml(asset)})`,
    `Порог: <b>${formatNumber(minRate, 4)}</b> · Лучший курс сейчас: <b>${best ? formatNumber(best.price, 4) : 'n/a'}</b>`,
    `Подходящих: <b>${matches.length}</b> из ${ads.length}`,
    '',
  ];
  const list = (matches.length > 0 ? matches : ads).slice(0, topN);
  const title =
    matches.length > 0 ? '✅ Подходящие предложения:' : '📉 Порог не достигнут. Лучшие сейчас:';
  return [...header, title, '', ...list.map((ad, i) => adShortLine(ad, i + 1))]
    .join('\n\n')
    .replace(/\n\n\n/g, '\n\n');
}

export function statusMessage(info: StatusInfo): string {
  const s = info.stats;
  const lastOk = s.lastSuccessfulCheckAt ? new Date(s.lastSuccessfulCheckAt) : null;
  const lastErr = s.lastCheckErrorAt ? new Date(s.lastCheckErrorAt) : null;
  const lines = [
    `📡 <b>Статус мониторинга</b>`,
    `Состояние: ${info.running ? '🟢 работает' : '🔴 остановлен'}`,
    `Пара: ${escapeHtml(info.asset)}/${escapeHtml(info.fiat)} (я продаю ${escapeHtml(info.asset)}, получаю ${escapeHtml(info.fiat)})`,
    `Порог: <b>≥ ${formatNumber(info.minRate, 4)} ${escapeHtml(info.fiat)}</b> за 1 ${escapeHtml(info.asset)}`,
    `Интервал: каждые ${Math.round(info.pollIntervalMs / 1000)} с`,
    `Аптайм: ${formatDuration(info.uptimeMs)}`,
    '',
    `🕒 Последняя успешная проверка: ${formatDateTime(lastOk, info.timezone)}`,
    `📦 Объявлений в последней проверке: ${s.lastAdsCount}`,
    `✅ Подходящих в последней проверке: ${s.lastMatchCount}`,
    `🏆 Лучший курс за всё время: ${s.bestPriceSeen !== null ? formatNumber(s.bestPriceSeen, 4) : 'n/a'}`,
    `🔔 Уведомлений отправлено: ${s.totalNotifications}`,
    `🔁 Проверок всего: ${s.totalChecks}`,
    `🗂 Отслеживаемых ID: ${info.trackedAds}`,
  ];
  if (s.lastCheckError) {
    lines.push(
      '',
      `⚠️ Последняя ошибка (${formatDateTime(lastErr, info.timezone)}): ${escapeHtml(s.lastCheckError)}`,
    );
  }
  if (info.cooldownMs > 0) {
    lines.push(`⏳ Rate-limit cooldown: ещё ${formatDuration(info.cooldownMs)}`);
  }
  return lines.join('\n');
}

export function startMessage(info: StatusInfo): string {
  return [
    `👋 <b>Binance P2P Alert Bot</b>`,
    '',
    `Я слежу за публичными объявлениями Binance P2P по паре ${escapeHtml(info.asset)}/${escapeHtml(info.fiat)}`,
    `и присылаю уведомление, когда кто-то готов <b>купить ${escapeHtml(info.asset)}</b> по курсу`,
    `<b>≥ ${formatNumber(info.minRate, 4)} ${escapeHtml(info.fiat)}</b> (то есть вы продаёте ${escapeHtml(info.asset)} и получаете ${escapeHtml(info.fiat)}).`,
    '',
    `Проверка каждые ${Math.round(info.pollIntervalMs / 1000)} с. Никаких сделок бот не совершает.`,
    '',
    '<b>Команды</b>',
    '/status — состояние мониторинга',
    '/rate 1.705 — изменить минимальный курс',
    '/check — проверить прямо сейчас и показать лучшие предложения',
    '/help — эта справка',
  ].join('\n');
}

export function rateUsageMessage(current: number, fiat: string, asset: string): string {
  return [
    `Текущий порог: <b>${formatNumber(current, 4)} ${escapeHtml(fiat)}</b> за 1 ${escapeHtml(asset)}.`,
    'Чтобы изменить: <code>/rate 1.705</code>',
  ].join('\n');
}
