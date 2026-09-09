import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore } from '../src/storage/stateStore.js';

const logger = pino({ level: 'silent' });
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'p2p-state-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('StateStore', () => {
  it('starts fresh with default rate and persists changes across restarts', async () => {
    const s1 = new StateStore(dir, 1.7, logger);
    await s1.load();
    expect(s1.minRate).toBe(1.7);
    s1.setMinRate(1.705);
    s1.setAd('a', {
      lastPrice: 1.71,
      lastAbove: true,
      lastSeenAt: new Date().toISOString(),
      notifiedAt: null,
      notifyCount: 1,
    });
    await s1.flushIfDirty();

    const s2 = new StateStore(dir, 1.7, logger);
    await s2.load();
    expect(s2.minRate).toBe(1.705);
    expect(s2.getAd('a')?.lastAbove).toBe(true);
    const raw = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')) as {
      version: number;
    };
    expect(raw.version).toBe(1);
  });

  it('prunes ads older than TTL', async () => {
    const s = new StateStore(dir, 1.7, logger);
    await s.load();
    const now = new Date('2026-09-09T12:00:00Z');
    s.setAd('old', {
      lastPrice: 1,
      lastAbove: false,
      lastSeenAt: '2026-09-08T11:00:00Z',
      notifiedAt: null,
      notifyCount: 0,
    });
    s.setAd('new', {
      lastPrice: 1,
      lastAbove: false,
      lastSeenAt: '2026-09-09T11:30:00Z',
      notifiedAt: null,
      notifyCount: 0,
    });
    s.setAd('broken', {
      lastPrice: 1,
      lastAbove: false,
      lastSeenAt: 'not-a-date',
      notifiedAt: null,
      notifyCount: 0,
    });
    const removed = s.pruneAds(24 * 3600 * 1000, now);
    expect(removed).toBe(2);
    expect(s.getAd('new')).toBeDefined();
    expect(s.trackedAdCount).toBe(1);
  });

  it('recovers from a corrupted state file', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, 'state.json'), '{not json', 'utf8');
    const s = new StateStore(dir, 1.7, logger);
    await s.load();
    expect(s.minRate).toBe(1.7);
    expect(s.trackedAdCount).toBe(0);
  });
});
