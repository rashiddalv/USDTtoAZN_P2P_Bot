import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';

const base = { TELEGRAM_BOT_TOKEN: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };

describe('loadConfig: allowed users', () => {
  it('parses a comma/space separated list and keeps order', () => {
    const cfg = loadConfig({ ...base, TELEGRAM_ALLOWED_USER_IDS: '111, 222,333' });
    expect(cfg.telegram.allowedUserIds).toEqual([111, 222, 333]);
  });

  it('still accepts the legacy single-user variable and merges it first', () => {
    const cfg = loadConfig({
      ...base,
      TELEGRAM_ALLOWED_USER_ID: '111',
      TELEGRAM_ALLOWED_USER_IDS: '222,111',
    });
    expect(cfg.telegram.allowedUserIds).toEqual([111, 222]);
  });

  it('rejects an empty list and non-numeric ids', () => {
    expect(() => loadConfig({ ...base })).toThrow(/at least one Telegram user id/);
    expect(() => loadConfig({ ...base, TELEGRAM_ALLOWED_USER_IDS: '111,abc' })).toThrow(
      /not a numeric Telegram user id/,
    );
  });
});
