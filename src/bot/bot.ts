import { Bot, GrammyError, HttpError, type Context, type InlineKeyboard } from 'grammy';
import type { AppConfig } from '../config/index.js';
import type { CheckResult, Monitor } from '../monitor/monitor.js';
import type { BinanceP2PService } from '../services/binanceP2P.service.js';
import type { P2PAd } from '../services/binanceP2P.types.js';
import type { StateStore } from '../storage/stateStore.js';
import { errorMessage, escapeHtml, formatNumber } from '../utils/format.js';
import type { Logger } from '../utils/logger.js';
import {
  CB,
  alertKeyboard,
  backToMenuKeyboard,
  checkResultKeyboard,
  mainMenuKeyboard,
  rateMenuKeyboard,
  statusKeyboard,
} from './keyboards.js';
import {
  adAlertMessage,
  checkResultMessage,
  helpMessage,
  menuMessage,
  rateMenuMessage,
  rateUpdatedMessage,
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

/** Sanity bounds for the threshold: AZN is pegged ~1.70 per USD, anything far outside is a typo. */
export const RATE_MIN = 0.5;
export const RATE_MAX = 10;

const HTML = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

export function createBot(deps: BotDeps): Bot {
  const { config, store, monitor, provider } = deps;
  const log = deps.logger.child({ module: 'telegram' });
  const bot = new Bot(config.telegram.token);
  const allowedId = config.telegram.allowedUserId;
  const { asset, fiat } = config.binance;

  // ---- access control: single-user bot ----
  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (fromId !== allowedId) {
      log.warn({ fromId, chatId: ctx.chat?.id, text: ctx.message?.text }, 'access denied');
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: 'Access denied.' }).catch(() => undefined);
      } else if (ctx.chat?.type === 'private') {
        await ctx.reply('Access denied.').catch(() => undefined);
      }
      return;
    }
    await next();
  });

  const statusInfo = (): StatusInfo => ({
    running: monitor.isRunning,
    minRate: store.minRate,
    asset,
    fiat,
    pollIntervalMs: monitor.pollIntervalMs,
    uptimeMs: monitor.uptimeMs,
    stats: store.stats,
    trackedAds: store.trackedAdCount,
    cooldownMs: provider.cooldownRemainingMs,
    timezone: config.timezone,
  });

  /**
   * Show a screen: edit the message in place when triggered from a button,
   * otherwise send a new message. "message is not modified" is ignored.
   */
  const show = async (ctx: Context, text: string, keyboard: InlineKeyboard): Promise<void> => {
    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(text, { ...HTML, reply_markup: keyboard });
        return;
      } catch (err) {
        if (err instanceof GrammyError && err.description.includes('message is not modified'))
          return;
        log.debug({ err: errorMessage(err) }, 'edit failed, sending new message');
      }
    }
    await ctx.reply(text, { ...HTML, reply_markup: keyboard });
  };

  const renderCheck = (result: CheckResult) => {
    const { text, shown } = checkResultMessage(
      result.ads,
      result.matches,
      result.minRate,
      asset,
      fiat,
      config.monitor.checkTopN,
      result.checkedAt,
      config.timezone,
    );
    return { text, keyboard: checkResultKeyboard(shown, asset, fiat) };
  };

  const runCheck = async (ctx: Context): Promise<void> => {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: '⏳ Проверяю Binance…' }).catch(() => undefined);
    } else {
      await ctx.replyWithChatAction('typing').catch(() => undefined);
    }
    try {
      const result = await monitor.checkNow();
      const { text, keyboard } = renderCheck(result);
      await show(ctx, text, keyboard);
    } catch (err) {
      const msg = errorMessage(err);
      log.error({ err: msg }, 'check failed');
      await show(
        ctx,
        `❌ <b>Не удалось получить данные</b>\n<code>${escapeHtml(msg)}</code>`,
        backToMenuKeyboard(),
      );
    }
  };

  const applyRate = async (ctx: Context, value: number): Promise<void> => {
    if (!Number.isFinite(value) || value < RATE_MIN || value > RATE_MAX) {
      const text = `❌ Курс должен быть в диапазоне ${RATE_MIN}–${RATE_MAX} ${escapeHtml(fiat)}.`;
      if (ctx.callbackQuery)
        await ctx.answerCallbackQuery({ text, show_alert: true }).catch(() => undefined);
      else await ctx.reply(text);
      return;
    }
    const rounded = Math.round(value * 10_000) / 10_000;
    const previous = store.minRate;
    store.setMinRate(rounded);
    await store.flushIfDirty();
    log.info({ previous, minRate: rounded }, 'min rate updated');
    if (ctx.callbackQuery) {
      await ctx
        .answerCallbackQuery({ text: `Порог: ${formatNumber(rounded, 4)} ${fiat}` })
        .catch(() => undefined);
      await show(ctx, rateMenuMessage(rounded, fiat, asset), rateMenuKeyboard(rounded));
    } else {
      await ctx.reply(rateUpdatedMessage(previous, rounded, fiat), {
        ...HTML,
        reply_markup: backToMenuKeyboard(),
      });
    }
  };

  // ---- commands ----

  bot.command('start', async (ctx) => {
    await show(ctx, menuMessage(statusInfo()), mainMenuKeyboard(asset, fiat));
  });

  bot.command('help', async (ctx) => {
    await show(ctx, helpMessage(), backToMenuKeyboard());
  });

  bot.command('status', async (ctx) => {
    await show(ctx, statusMessage(statusInfo()), statusKeyboard());
  });

  bot.command('check', runCheck);

  bot.command('rate', async (ctx) => {
    const arg = ctx.match.trim().replace(',', '.');
    if (arg === '') {
      await show(ctx, rateMenuMessage(store.minRate, fiat, asset), rateMenuKeyboard(store.minRate));
      return;
    }
    if (!/^\d+(\.\d+)?$/.test(arg)) {
      await ctx.reply(
        `❌ Некорректное значение <code>${escapeHtml(arg)}</code>. Пример: <code>/rate 1.705</code>`,
        HTML,
      );
      return;
    }
    await applyRate(ctx, Number(arg));
  });

  // ---- inline buttons ----

  bot.callbackQuery(CB.menu, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => undefined);
    await show(ctx, menuMessage(statusInfo()), mainMenuKeyboard(asset, fiat));
  });

  bot.callbackQuery(CB.help, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => undefined);
    await show(ctx, helpMessage(), backToMenuKeyboard());
  });

  bot.callbackQuery(CB.status, async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Обновлено' }).catch(() => undefined);
    await show(ctx, statusMessage(statusInfo()), statusKeyboard());
  });

  bot.callbackQuery(CB.check, runCheck);

  bot.callbackQuery(CB.rateMenu, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => undefined);
    await show(ctx, rateMenuMessage(store.minRate, fiat, asset), rateMenuKeyboard(store.minRate));
  });

  bot.callbackQuery(new RegExp(`^${CB.rateDelta}(-?\\d+(?:\\.\\d+)?)$`), async (ctx) => {
    const delta = Number(ctx.match[1]);
    await applyRate(ctx, store.minRate + delta);
  });

  bot.callbackQuery(new RegExp(`^${CB.rateSet}(\\d+(?:\\.\\d+)?)$`), async (ctx) => {
    await applyRate(ctx, Number(ctx.match[1]));
  });

  bot.on('callback_query:data', async (ctx) => {
    await ctx
      .answerCallbackQuery({ text: 'Кнопка устарела, откройте /start' })
      .catch(() => undefined);
  });

  bot.on('message', async (ctx) => {
    await show(ctx, 'Не понял команду. Используйте меню ниже 👇', mainMenuKeyboard(asset, fiat));
  });

  bot.catch((err) => {
    const cause = err.error;
    if (cause instanceof GrammyError) {
      log.error({ description: cause.description, method: cause.method }, 'Telegram API error');
    } else if (cause instanceof HttpError) {
      log.error({ err: errorMessage(cause) }, 'Telegram HTTP error');
    } else {
      log.error({ err: errorMessage(cause) }, 'unhandled bot error');
    }
  });

  return bot;
}

/** Sends one alert per ad to the allowed user. Throws if *all* sends failed. */
export async function sendAlerts(
  bot: Bot,
  config: AppConfig,
  ads: P2PAd[],
  minRate: number,
  log: Logger,
): Promise<void> {
  let failures = 0;
  for (const ad of ads) {
    try {
      await bot.api.sendMessage(config.telegram.allowedUserId, adAlertMessage(ad, minRate), {
        ...HTML,
        reply_markup: alertKeyboard(ad),
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
