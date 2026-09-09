import 'dotenv/config';
import { z } from 'zod';

const numberFromEnv = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : Number(v)))
    .pipe(z.number().finite());

/** Comma/space separated list of positive integers, e.g. "123, 456". */
const userIdList = z
  .string()
  .optional()
  .transform((v, ctx) => {
    const ids: number[] = [];
    for (const part of (v ?? '').split(/[,\s]+/)) {
      if (part === '') continue;
      if (!/^\d+$/.test(part)) {
        ctx.addIssue({ code: 'custom', message: `"${part}" is not a numeric Telegram user id` });
        continue;
      }
      const id = Number(part);
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  });

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(10, 'TELEGRAM_BOT_TOKEN is required'),
  /** Preferred: several users. */
  TELEGRAM_ALLOWED_USER_IDS: userIdList,
  /** Legacy single-user variable, still honoured (merged with the list above). */
  TELEGRAM_ALLOWED_USER_ID: userIdList,

  MIN_RATE: numberFromEnv(1.7).pipe(z.number().positive()),
  POLL_INTERVAL_SECONDS: numberFromEnv(45).pipe(z.number().int().positive()),
  NOTIFIED_TTL_HOURS: numberFromEnv(24).pipe(z.number().positive()),
  CHECK_TOP_N: numberFromEnv(5).pipe(z.number().int().min(1).max(20)),

  ASSET: z.string().trim().toUpperCase().default('USDT'),
  FIAT: z.string().trim().toUpperCase().default('AZN'),
  BINANCE_TIMEOUT_MS: numberFromEnv(15_000).pipe(z.number().int().min(1_000)),
  BINANCE_RETRY_ATTEMPTS: numberFromEnv(3).pipe(z.number().int().min(1).max(10)),
  BINANCE_MAX_PAGES: numberFromEnv(3).pipe(z.number().int().min(1).max(10)),

  DATA_DIR: z.string().default('./data'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
  TZ: z.string().default('Asia/Baku'),
});

export type LogLevel = z.infer<typeof envSchema>['LOG_LEVEL'];

export interface AppConfig {
  telegram: {
    token: string;
    /** Users allowed to talk to the bot and receive alerts. First one is the primary (owner). */
    allowedUserIds: number[];
  };
  monitor: {
    defaultMinRate: number;
    pollIntervalMs: number;
    notifiedTtlMs: number;
    checkTopN: number;
  };
  binance: {
    asset: string;
    fiat: string;
    timeoutMs: number;
    retryAttempts: number;
    maxPages: number;
  };
  dataDir: string;
  log: { level: LogLevel; format: 'json' | 'pretty' };
  timezone: string;
}

export const MIN_POLL_INTERVAL_SECONDS = 7;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;
  const allowedUserIds = [...e.TELEGRAM_ALLOWED_USER_ID, ...e.TELEGRAM_ALLOWED_USER_IDS].filter(
    (id, i, arr) => arr.indexOf(id) === i,
  );
  if (allowedUserIds.length === 0) {
    throw new Error(
      'Invalid environment configuration:\n  - TELEGRAM_ALLOWED_USER_IDS: at least one Telegram user id is required',
    );
  }
  const pollSeconds = Math.max(e.POLL_INTERVAL_SECONDS, MIN_POLL_INTERVAL_SECONDS);

  return {
    telegram: { token: e.TELEGRAM_BOT_TOKEN, allowedUserIds },
    monitor: {
      defaultMinRate: e.MIN_RATE,
      pollIntervalMs: pollSeconds * 1000,
      notifiedTtlMs: e.NOTIFIED_TTL_HOURS * 60 * 60 * 1000,
      checkTopN: e.CHECK_TOP_N,
    },
    binance: {
      asset: e.ASSET,
      fiat: e.FIAT,
      timeoutMs: e.BINANCE_TIMEOUT_MS,
      retryAttempts: e.BINANCE_RETRY_ATTEMPTS,
      maxPages: e.BINANCE_MAX_PAGES,
    },
    dataDir: e.DATA_DIR,
    log: { level: e.LOG_LEVEL, format: e.LOG_FORMAT },
    timezone: e.TZ,
  };
}
