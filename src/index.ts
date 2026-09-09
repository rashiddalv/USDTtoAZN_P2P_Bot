import type { Bot } from 'grammy';
import { createBot, sendAlerts } from './bot/bot.js';
import { loadConfig } from './config/index.js';
import { Monitor } from './monitor/monitor.js';
import { BinanceP2PService } from './services/binanceP2P.service.js';
import { StateStore } from './storage/stateStore.js';
import { errorMessage } from './utils/format.js';
import { createLogger } from './utils/logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  process.env.TZ = config.timezone;
  const logger = createLogger(config.log.level, config.log.format);

  logger.info(
    {
      asset: config.binance.asset,
      fiat: config.binance.fiat,
      pollIntervalMs: config.monitor.pollIntervalMs,
      timezone: config.timezone,
      allowedUsers: config.telegram.allowedUserIds.length,
      node: process.version,
    },
    'starting binance-p2p-alert',
  );

  const store = new StateStore(
    config.dataDir,
    {
      defaultMinRate: config.monitor.defaultMinRate,
      primaryUserId: config.telegram.allowedUserIds[0],
    },
    logger,
  );
  await store.load();

  const provider = new BinanceP2PService({
    asset: config.binance.asset,
    fiat: config.binance.fiat,
    timeoutMs: config.binance.timeoutMs,
    retryAttempts: config.binance.retryAttempts,
    logger,
  });

  // The monitor needs the bot for delivery; the bot needs the monitor for /check. Resolve lazily.
  let botRef: Bot | null = null;
  const monitor = new Monitor({
    provider,
    store,
    logger,
    pollIntervalMs: config.monitor.pollIntervalMs,
    notifiedTtlMs: config.monitor.notifiedTtlMs,
    maxPages: config.binance.maxPages,
    defaultMinRate: config.monitor.defaultMinRate,
    allowedUserIds: config.telegram.allowedUserIds,
    onNewMatches: (userId, ads, minRate) => {
      if (!botRef) return Promise.reject(new Error('bot not initialised'));
      return sendAlerts(botRef, userId, ads, minRate, logger.child({ module: 'alerts' }));
    },
  });
  const bot = createBot({ config, store, monitor, provider, logger });
  botRef = bot;

  // ---- graceful shutdown ----
  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, 'shutting down');
    const timer = setTimeout(() => {
      logger.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, 10_000);
    timer.unref();
    try {
      await monitor.stop();
      await bot.stop();
      await store.flushIfDirty();
      logger.info('shutdown complete');
    } catch (err) {
      logger.error({ err: errorMessage(err) }, 'error during shutdown');
    } finally {
      clearTimeout(timer);
      process.exit(0);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) =>
    logger.error({ err: errorMessage(err) }, 'unhandled rejection'),
  );
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: errorMessage(err), stack: err.stack }, 'uncaught exception');
    void shutdown('uncaughtException');
  });

  // ---- start ----
  await bot.api.setMyCommands([
    { command: 'start', description: 'Главное меню' },
    { command: 'status', description: 'Состояние мониторинга' },
    { command: 'rate', description: 'Изменить минимальный курс, напр. /rate 1.705' },
    { command: 'check', description: 'Проверить сейчас и показать лучшие предложения' },
    { command: 'help', description: 'Как работает бот и ссылки' },
  ]);

  monitor.start();

  // Long polling runs until bot.stop(); it is independent of the monitor loop.
  await bot.start({
    drop_pending_updates: true,
    onStart: (info) => logger.info({ username: info.username }, 'telegram bot started'),
  });
}

main().catch((err: unknown) => {
  console.error('Fatal error during startup:', err instanceof Error ? err.message : err);
  process.exit(1);
});
