import { Bot, GrammyError, HttpError, type Context, type InlineKeyboard } from 'grammy';
import type { AppConfig } from '../config/index.js';
import type { CheckResult, Monitor } from '../monitor/monitor.js';
import type { BinanceP2PService } from '../services/binanceP2P.service.js';
import { matchesThreshold } from '../monitor/matcher.js';
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
  const allowedIds = new Set(config.telegram.allowedUserIds);
  const { asset, fiat } = config.binance;

  // ---- access control: only whitelisted users; each gets their own settings ----
  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (fromId === undefined || !allowedIds.has(fromId)) {
      log.warn({ fromId, chatId: ctx.chat?.id, text: ctx.message?.text }, 'access denied');
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: 'Access denied.' }).catch(() => undefined);
      } else if (ctx.chat?.type === 'private') {
        await ctx.reply('Access denied.').catch(() => undefined);
      }
      return;
    }
    // First contact: register the user so the monitor starts evaluating ads for them.
    if (!store.hasUser(fromId)) {
      store.ensureUser(fromId);
      await store.flushIfDirty();
    }
    await next();
  });

  /** Id of the user who sent the update. Only called after the access middleware. */
  const userOf = (ctx: Context): number => {
    const id = ctx.from?.id;
    if (id === undefined) throw new Error('update without sender');
    return id;
  };

  const statusInfo = (userId: number): StatusInfo => {
    const user = store.ensureUser(userId);
    return {
      running: monitor.isRunning,
      minRate: user.minRate,
      asset,
      fiat,
      pollIntervalMs: monitor.pollIntervalMs,
      uptimeMs: monitor.uptimeMs,
      stats: store.stats,
      totalNotifications: user.totalNotifications,
      lastMatchCount: user.lastMatchCount,
      trackedAds: store.trackedAdCountFor(userId),
      cooldownMs: provider.cooldownRemainingMs,
      timezone: config.timezone,
    };
  };

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

  const renderCheck = (result: CheckResult, userId: number) => {
    // The check may have started before this user registered; fall back to a plain filter.
    const mine = result.users.get(userId);
    const minRate = mine?.minRate ?? store.ensureUser(userId).minRate;
    const matches = mine?.matches ?? result.ads.filter((ad) => matchesThreshold(ad, minRate));
    const { text, shown } = checkResultMessage(
      result.ads,
      matches,
      minRate,
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
      const { text, keyboard } = renderCheck(result, userOf(ctx));
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
    const userId = userOf(ctx);
    const rounded = Math.round(value * 10_000) / 10_000;
    const previous = store.ensureUser(userId).minRate;
    store.setMinRate(userId, rounded);
    await store.flushIfDirty();
    log.info({ userId, previous, minRate: rounded }, 'min rate updated');
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
    await show(ctx, menuMessage(statusInfo(userOf(ctx))), mainMenuKeyboard(asset, fiat));
  });

  bot.command('help', async (ctx) => {
    await show(ctx, helpMessage(), backToMenuKeyboard());
  });

  bot.command('status', async (ctx) => {
    await show(ctx, statusMessage(statusInfo(userOf(ctx))), statusKeyboard());
  });

  bot.command('check', runCheck);

  bot.command('rate', async (ctx) => {
    const arg = ctx.match.trim().replace(',', '.');
    if (arg === '') {
      const current = store.ensureUser(userOf(ctx)).minRate;
      await show(ctx, rateMenuMessage(current, fiat, asset), rateMenuKeyboard(current));
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
    await show(ctx, menuMessage(statusInfo(userOf(ctx))), mainMenuKeyboard(asset, fiat));
  });

  bot.callbackQuery(CB.help, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => undefined);
    await show(ctx, helpMessage(), backToMenuKeyboard());
  });

  bot.callbackQuery(CB.status, async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Обновлено' }).catch(() => undefined);
    await show(ctx, statusMessage(statusInfo(userOf(ctx))), statusKeyboard());
  });

  bot.callbackQuery(CB.check, runCheck);

  bot.callbackQuery(CB.rateMenu, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => undefined);
    const current = store.ensureUser(userOf(ctx)).minRate;
    await show(ctx, rateMenuMessage(current, fiat, asset), rateMenuKeyboard(current));
  });

  bot.callbackQuery(new RegExp(`^${CB.rateDelta}(-?\\d+(?:\\.\\d+)?)$`), async (ctx) => {
    const delta = Number(ctx.match[1]);
    await applyRate(ctx, store.ensureUser(userOf(ctx)).minRate + delta);
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

/**
 * Sends one alert per ad to `userId`. Throws if *all* sends failed, so the monitor
 * can retry on the next check. A user who blocked the bot (403) is treated as delivered:
 * retrying would only spam the log every check.
 */
export async function sendAlerts(
  bot: Bot,
  userId: number,
  ads: P2PAd[],
  minRate: number,
  log: Logger,
): Promise<void> {
  let failures = 0;
  for (const ad of ads) {
    try {
      await bot.api.sendMessage(userId, adAlertMessage(ad, minRate), {
        ...HTML,
        reply_markup: alertKeyboard(ad),
      });
      log.info(
        { userId, advNo: ad.id, price: ad.price, nick: ad.advertiser.nickName },
        'alert sent',
      );
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 403) {
        log.warn({ userId, err: errorMessage(err) }, 'user blocked the bot; skipping alerts');
        return;
      }
      failures++;
      log.error({ userId, advNo: ad.id, err: errorMessage(err) }, 'failed to send alert');
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
