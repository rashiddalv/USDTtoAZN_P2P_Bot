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
  /** Shared monitor stats (one Binance check serves every user). */
  stats: MonitorStats;
  /** This user's counters. */
  totalNotifications: number;
  lastMatchCount: number;
  trackedAds: number;
  cooldownMs: number;
  timezone: string;
}

const e = escapeHtml;

/** Trust indicator based on 30-day completion rate. */
function trustIcon(rate: number | null): string {
  if (rate === null) return '⚪️';
  if (rate >= 0.97) return '🟢';
  if (rate >= 0.9) return '🟡';
  return '🔴';
}

function traderLine(ad: P2PAd): string {
  const a = ad.advertiser;
  const badge = a.isMerchant ? ' <i>merchant</i> ✔️' : '';
  return `👤 <b>${e(a.nickName)}</b>${badge}`;
}

function traderStats(ad: P2PAd): string {
  const a = ad.advertiser;
  const parts = [
    `${trustIcon(a.completionRate)} ${formatPercent(a.completionRate)} завершено`,
    `🔄 ${a.monthOrderCount ?? 'n/a'} сделок/30д`,
  ];
  if (a.positiveRate !== null) parts.push(`👍 ${formatPercent(a.positiveRate)}`);
  return parts.join(' · ');
}

function pad(label: string, width = 10): string {
  return label.padEnd(width, ' ');
}

/** Monospace key/value block so numbers line up on any device. */
function adTable(ad: P2PAd): string {
  const rows = [
    `${pad('Доступно')}${formatNumber(ad.availableAsset)} ${ad.asset}`,
    `${pad('Лимиты')}${formatNumber(ad.minFiat)} – ${formatNumber(ad.maxFiat)} ${ad.fiat}`,
    `${pad('Оплата')}${ad.paymentMethods.join(', ') || 'n/a'}`,
  ];
  if (ad.payTimeLimitMin) rows.push(`${pad('Окно')}${ad.payTimeLimitMin} мин`);
  return `<pre>${e(rows.join('\n'))}</pre>`;
}

export function adAlertMessage(ad: P2PAd, minRate: number): string {
  const diff = ad.price - minRate;
  const diffText =
    diff > 0 ? ` · <i>+${formatNumber(diff, 4)} к порогу</i>` : ' · <i>ровно порог</i>';
  return [
    `🟢 <b>Хороший курс</b> · Binance P2P`,
    '',
    `💵 <b>1 ${e(ad.asset)} = ${formatNumber(ad.price, 4)} ${e(ad.fiat)}</b>`,
    `<i>порог ≥ ${formatNumber(minRate, 4)}</i>${diffText}`,
    '',
    adTable(ad),
    traderLine(ad),
    traderStats(ad),
    '',
    `🆔 <code>${e(ad.id)}</code>`,
  ].join('\n');
}

function adCompactCard(ad: P2PAd, index: number, minRate: number): string {
  const ok = ad.price >= minRate ? '✅' : '▫️';
  return [
    `${ok} <b>${index}. ${formatNumber(ad.price, 4)} ${e(ad.fiat)}</b> — ${e(ad.advertiser.nickName)}${ad.advertiser.isMerchant ? ' ✔️' : ''}`,
    `      💰 ${formatNumber(ad.availableAsset)} ${e(ad.asset)} · 📊 ${formatNumber(ad.minFiat)}–${formatNumber(ad.maxFiat)}`,
    `      ${trustIcon(ad.advertiser.completionRate)} ${formatPercent(ad.advertiser.completionRate)} · 🔄 ${ad.advertiser.monthOrderCount ?? 'n/a'} · 🏦 ${e(ad.paymentMethods.join(', ') || 'n/a')}`,
  ].join('\n');
}

export function checkResultMessage(
  ads: P2PAd[],
  matches: P2PAd[],
  minRate: number,
  asset: string,
  fiat: string,
  topN: number,
  checkedAt: Date,
  timezone: string,
): { text: string; shown: P2PAd[] } {
  if (ads.length === 0) {
    return {
      text: `⚠️ Binance не вернул ни одного объявления для ${e(asset)}/${e(fiat)}.`,
      shown: [],
    };
  }
  const best = ads[0]!;
  const gap = best.price - minRate;
  const verdict =
    matches.length > 0
      ? `✅ <b>Подходящих: ${matches.length}</b> из ${ads.length}`
      : `📉 Порог не достигнут · до порога <b>${formatNumber(-gap, 4)}</b>`;
  const shown = (matches.length > 0 ? matches : ads).slice(0, topN);

  const text = [
    `🔍 <b>${e(asset)} → ${e(fiat)}</b> · продажа ${e(asset)}`,
    `<i>${formatDateTime(checkedAt, timezone)}</i>`,
    '',
    `🏆 Лучший курс: <b>${formatNumber(best.price, 4)}</b> · порог ≥ ${formatNumber(minRate, 4)}`,
    verdict,
    '',
    ...shown.map((ad, i) => adCompactCard(ad, i + 1, minRate)),
    '',
    `<i>Нажмите на объявление ниже, чтобы открыть трейдера в приложении Binance.</i>`,
  ].join('\n');
  return { text, shown };
}

export function statusMessage(info: StatusInfo): string {
  const s = info.stats;
  const lastOk = s.lastSuccessfulCheckAt ? new Date(s.lastSuccessfulCheckAt) : null;
  const lastErr = s.lastCheckErrorAt ? new Date(s.lastCheckErrorAt) : null;
  const state = info.running ? '🟢 работает' : '🔴 остановлен';

  const lines = [
    `📡 <b>Мониторинг</b> · ${state}`,
    '',
    `💱 ${e(info.asset)} → ${e(info.fiat)} · продажа ${e(info.asset)}`,
    `🎯 Порог: <b>≥ ${formatNumber(info.minRate, 4)} ${e(info.fiat)}</b>`,
    `⏱ Каждые ${Math.round(info.pollIntervalMs / 1000)} с · аптайм ${formatDuration(info.uptimeMs)}`,
    '',
    `<pre>${e(
      [
        `${pad('Проверка', 12)}${formatDateTime(lastOk, info.timezone)}`,
        `${pad('Объявлений', 12)}${s.lastAdsCount}`,
        `${pad('Подходящих', 12)}${info.lastMatchCount}`,
        `${pad('Лучший курс', 12)}${s.bestPriceSeen !== null ? formatNumber(s.bestPriceSeen, 4) : 'n/a'}`,
        `${pad('Уведомлений', 12)}${info.totalNotifications}`,
        `${pad('Проверок', 12)}${s.totalChecks}`,
        `${pad('В памяти', 12)}${info.trackedAds} ID`,
      ].join('\n'),
    )}</pre>`,
  ];
  if (s.lastCheckError) {
    lines.push(
      `⚠️ <b>Последняя ошибка</b> (${formatDateTime(lastErr, info.timezone)})`,
      `<code>${e(s.lastCheckError)}</code>`,
    );
  }
  if (info.cooldownMs > 0) {
    lines.push(`⏳ Rate-limit cooldown: ещё ${formatDuration(info.cooldownMs)}`);
  }
  return lines.join('\n');
}

export function menuMessage(info: StatusInfo): string {
  return [
    `🤖 <b>Binance P2P Alert</b>`,
    '',
    `Слежу за объявлениями ${e(info.asset)}/${e(info.fiat)}, где контрагент <b>покупает ${e(info.asset)}</b>`,
    `(вы продаёте ${e(info.asset)} и получаете ${e(info.fiat)}).`,
    '',
    `🎯 Порог: <b>≥ ${formatNumber(info.minRate, 4)} ${e(info.fiat)}</b>`,
    `⏱ Проверка каждые ${Math.round(info.pollIntervalMs / 1000)} с · ${info.running ? '🟢 активен' : '🔴 остановлен'}`,
    '',
    `<i>Выберите действие:</i>`,
  ].join('\n');
}

export function helpMessage(): string {
  return [
    `❓ <b>Как это работает</b>`,
    '',
    `• Бот каждые 30–60 с читает публичные объявления Binance P2P.`,
    `• Как только кто-то готов купить USDT по курсу не ниже порога, приходит уведомление.`,
    `• Одно и то же объявление не повторяется, пока его цена не упадёт ниже порога и не вернётся снова.`,
    `• Никаких сделок бот не совершает и доступа к аккаунту не имеет.`,
    `• Порог у каждого пользователя свой: ваш /rate не влияет на других.`,
    '',
    `<b>Команды</b>`,
    `/check — проверить сейчас`,
    `/status — состояние мониторинга`,
    `/rate 1.705 — задать порог вручную`,
    `/start — главное меню`,
    '',
    `<b>Ссылки</b>`,
    `📱 «Открыть в приложении» — открывает трейдера прямо в приложении Binance (iOS и Android).`,
    `🌐 «В браузере» — обычная ссылка на p2p.binance.com.`,
    `<i>Если Telegram открывает ссылки во встроенном браузере, отключите это в настройках Telegram → Данные и память → «Открывать ссылки в приложении», тогда приложение Binance будет открываться сразу.</i>`,
  ].join('\n');
}

export function rateMenuMessage(current: number, fiat: string, asset: string): string {
  return [
    `⚙️ <b>Минимальный курс</b>`,
    '',
    `Сейчас: <b>${formatNumber(current, 4)} ${e(fiat)}</b> за 1 ${e(asset)}`,
    '',
    `Нажмите ± чтобы подстроить, выберите пресет,`,
    `или отправьте вручную: <code>/rate 1.705</code>`,
  ].join('\n');
}

export function rateUpdatedMessage(previous: number, next: number, fiat: string): string {
  const arrow = next > previous ? '⬆️' : next < previous ? '⬇️' : '↔️';
  return [
    `✅ <b>Порог обновлён</b> ${arrow}`,
    '',
    `<s>${formatNumber(previous, 4)}</s> → <b>${formatNumber(next, 4)} ${e(fiat)}</b>`,
    '',
    `<i>Применится со следующей проверки. Объявления, впервые пересёкшие новый порог, придут уведомлением.</i>`,
  ].join('\n');
}
