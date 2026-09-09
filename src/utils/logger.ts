import pino, { type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string, format: 'json' | 'pretty'): Logger {
  const base = {
    level,
    base: { service: 'binance-p2p-alert' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (format === 'pretty') {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
      },
    });
  }
  return pino(base);
}
