import { Bot, GrammyError, HttpError, InlineKeyboard, type Context } from 'grammy';
import type { AppConfig } from '../config/index.js';
import type { Monitor } from '../monitor/monitor.js';
import type { BinanceP2PService } from '../services/binanceP2P.service.js';
import type { P2PAd } from '../services/binanceP2P.types.js';
import type { StateStore } from '../storage/stateStore.js';
import { errorMessage, escapeHtml, formatNumber } from '../utils/format.js';
import type { Logger } from '../utils/logger.js';
import {
  adAlertMessage,
  checkResultMessage,
  rateUsageMessage,
  startMessage,
  statusMessage,
  type StatusInfo,
} from './messages.js';

export interface BotDeps {
  config: AppConfig;
  store: StateStore;
  monitor: Monitor;
  provider: BinanceP2PService;
  logger: Logger;
}

/** Sanity bounds for /rate: AZN is pegged ~1.70 per USD, so anything far outside is a typo. */
const RATE_MIN = 0.5;
const RATE_MAX = 10;

export function createBot(deps: BotDeps): Bot {
  const { config, store, monitor, provider } = deps;
  const log = deps.logger.child({ module: 'telegram' });
  const bot = new Bot(config.telegram.token);
  const allowedId = config.telegram.allowedUserId;

  // ---- access control: single-user bot ----
  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (fromId !== allowedId) {
      log.warn({ fromId, chatId: ctx.chat?.id, text: ctx.message?.text }, 'access denied');
      if (ctx.chat?.type === 'private') {
        await ctx.reply('Access denied.').catch(() => undefined);
      }
      return;
    }
    await next();
  });

  const statusInfo = (): StatusInfo => ({
    running: monitor.isRunning,
    minRate: store.minRate,
    asset: config.binance.asset,
    fiat: config.binance.fiat,
    pollIntervalMs: monitor.pollIntervalMs,
    uptimeMs: monitor.uptimeMs,
    stats: store.stats,
    trackedAds: store.trackedAdCount,
    cooldownMs: provider.cooldownRemainingMs,
    timezone: config.timezone,
  });

  const replyHtml = (ctx: Context, text: string, extra: Record<string, unknown> = {}) =>
    ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });

  bot.command(['start', 'help'], async (ctx) => {
    await replyHtml(ctx, startMessage(statusInfo()));
  });

  bot.command('status', async (ctx) => {
    await replyHtml(ctx, statusMessage(statusInfo()));
  });

  bot.command('rate', async (ctx) => {
    const arg = ctx.match.trim().replace(',', '.');
    if (arg === '') {
      await replyHtml(
        ctx,
        rateUsageMessage(store.minRate, config.binance.fiat, config.binance.asset),
      );
      return;
    }
    if (!/^\d+(\.\d+)?$/.test(arg)) {
      await replyHtml(
        ctx,
        `❌ Некорректное значение <code>${escapeHtml(arg)}</code>. Пример: <code>/rate 1.705</code>`,
      );
      return;
    }
    const value = Number(arg);
    if (!Number.isFinite(value) || value < RATE_MIN || value > RATE_MAX) {
      await replyHtml(
        ctx,
        `❌ Курс должен быть в диапазоне ${RATE_MIN}–${RATE_MAX} ${escapeHtml(config.binance.fiat)}.`,
      );
      return;
    }
    const rounded = Math.round(value * 10_000) / 10_000;
    const previous = store.minRate;
    store.setMinRate(rounded);
    await store.flushIfDirty();
    log.info({ previous, minRate: rounded }, 'min rate updated');
    await replyHtml(
      ctx,
      `✅ Порог обновлён: <b>${formatNumber(rounded, 4)} ${escapeHtml(config.binance.fiat)}</b> (было ${formatNumber(previous, 4)}).\n` +
        'Применится со следующей проверки. Объявления, которые впервые пересекут новый порог, будут отправлены.',
    );
  });

  bot.command('check', async (ctx) => {
    const pending = await ctx.reply('⏳ Проверяю Binance P2P…');
    try {
      const result = await monitor.checkNow();
      const text = checkResultMessage(
        result.ads,
        result.matches,
        result.minRate,
        config.binance.asset,
        config.binance.fiat,
        config.monitor.checkTopN,
      );
      await ctx.api.editMessageText(pending.chat.id, pending.message_id, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard().url('Открыть список на Binance', marketUrl(config)),
      });
    } catch (err) {
      const msg = errorMessage(err);
      log.error({ err: msg }, '/check failed');
      await ctx.api
        .editMessageText(
          pending.chat.id,
          pending.message_id,
          `❌ Не удалось получить данные: ${escapeHtml(msg)}`,
          {
            parse_mode: 'HTML',
          },
        )
        .catch(() => undefined);
    }
  });

  bot.on('message', async (ctx) => {
    await replyHtml(ctx, 'Неизвестная команда. Доступно: /status, /rate, /check, /help');
  });

  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError)
      log.error({ description: e.description, method: e.method }, 'Telegram API error');
    else if (e instanceof HttpError) log.error({ err: errorMessage(e) }, 'Telegram HTTP error');
    else log.error({ err: errorMessage(e) }, 'unhandled bot error');
  });

  return bot;
}

export function marketUrl(config: AppConfig): string {
  return `https://p2p.binance.com/en/trade/sell/${encodeURIComponent(config.binance.asset)}?fiat=${encodeURIComponent(config.binance.fiat)}&payment=all-payments`;
}

/** Sends one alert per ad to the allowed user. Throws if *all* sends failed. */
export async function sendAlerts(
  bot: Bot,
  config: AppConfig,
  ads: P2PAd[],
  log: Logger,
): Promise<void> {
  let failures = 0;
  for (const ad of ads) {
    try {
      await bot.api.sendMessage(config.telegram.allowedUserId, adAlertMessage(ad), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard()
          .url('Открыть на Binance', ad.advertiserUrl)
          .row()
          .url('Список объявлений', ad.marketUrl),
      });
      log.info({ advNo: ad.id, price: ad.price, nick: ad.advertiser.nickName }, 'alert sent');
    } catch (err) {
      failures++;
      log.error({ advNo: ad.id, err: errorMessage(err) }, 'failed to send alert');
      if (err instanceof GrammyError && err.error_code === 429) {
        const retryAfter = (err.parameters.retry_after ?? 5) * 1000;
        await new Promise((r) => setTimeout(r, retryAfter));
      }
    }
  }
  if (failures > 0 && failures === ads.length) {
    throw new Error(`all ${failures} alert(s) failed to send`);
  }
}
