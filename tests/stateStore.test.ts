import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore, type AdTrack } from '../src/storage/stateStore.js';

const logger = pino({ level: 'silent' });
const OWNER = 111;
const FRIEND = 222;
let dir: string;

const track = (over: Partial<AdTrack> = {}): AdTrack => ({
  lastPrice: 1.71,
  lastAbove: true,
  lastSeenAt: new Date().toISOString(),
  notifiedAt: null,
  notifyCount: 1,
  ...over,
});

const make = (opts: { primaryUserId?: number } = { primaryUserId: OWNER }) =>
  new StateStore(dir, { defaultMinRate: 1.7, primaryUserId: opts.primaryUserId }, logger);

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'p2p-state-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('StateStore', () => {
  it('registers users with the default rate and persists per-user changes across restarts', async () => {
    const s1 = make();
    await s1.load();
    expect(s1.userIds()).toEqual([]);
    expect(s1.ensureUser(OWNER).minRate).toBe(1.7);
    expect(s1.ensureUser(FRIEND).minRate).toBe(1.7);
    s1.setMinRate(OWNER, 1.705);
    s1.setMinRate(FRIEND, 1.65);
    s1.setAd(OWNER, 'a', track());
    await s1.flushIfDirty();

    const s2 = make();
    await s2.load();
    expect(s2.userIds().sort()).toEqual([OWNER, FRIEND]);
    expect(s2.getMinRate(OWNER)).toBe(1.705);
    expect(s2.getMinRate(FRIEND)).toBe(1.65);
    expect(s2.lowestMinRate()).toBe(1.65);
    expect(s2.getAd(OWNER, 'a')?.lastAbove).toBe(true);
    expect(s2.getAd(FRIEND, 'a')).toBeUndefined();
    const raw = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')) as {
      version: number;
    };
    expect(raw.version).toBe(2);
  });

  it('ensureUser is idempotent and does not reset settings', async () => {
    const s = make();
    await s.load();
    s.ensureUser(OWNER);
    s.setMinRate(OWNER, 1.8);
    expect(s.ensureUser(OWNER).minRate).toBe(1.8);
    expect(s.hasUser(FRIEND)).toBe(false);
    expect(() => s.setMinRate(FRIEND, 1)).toThrow(/unknown user/);
  });

  it('migrates a v1 single-user file to the primary user', async () => {
    const v1 = {
      version: 1,
      settings: { minRate: 1.72 },
      ads: { x: track({ lastPrice: 1.73 }) },
      stats: {
        lastSuccessfulCheckAt: '2026-09-09T10:00:00.000Z',
        lastCheckError: null,
        lastCheckErrorAt: null,
        totalChecks: 42,
        totalNotifications: 7,
        lastAdsCount: 20,
        lastMatchCount: 3,
        bestPriceSeen: 1.75,
      },
    };
    await writeFile(path.join(dir, 'state.json'), JSON.stringify(v1), 'utf8');
    const s = make();
    await s.load();
    expect(s.userIds()).toEqual([OWNER]);
    const owner = s.getUser(OWNER)!;
    expect(owner.minRate).toBe(1.72);
    expect(owner.totalNotifications).toBe(7);
    expect(owner.lastMatchCount).toBe(3);
    expect(s.getAd(OWNER, 'x')?.lastPrice).toBe(1.73);
    expect(s.stats.totalChecks).toBe(42);
    expect(s.stats.bestPriceSeen).toBe(1.75);
    // migration is written back immediately
    const raw = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')) as {
      version: number;
    };
    expect(raw.version).toBe(2);
  });

  it('drops v1 settings when no primary user is configured', async () => {
    await writeFile(
      path.join(dir, 'state.json'),
      JSON.stringify({ version: 1, settings: { minRate: 1.72 }, ads: {}, stats: {} }),
      'utf8',
    );
    const s = make({});
    await s.load();
    expect(s.userIds()).toEqual([]);
  });

  it('prunes ads older than TTL for every user', async () => {
    const s = make();
    await s.load();
    s.ensureUser(OWNER);
    s.ensureUser(FRIEND);
    const now = new Date('2026-09-09T12:00:00Z');
    s.setAd(OWNER, 'old', track({ lastSeenAt: '2026-09-08T11:00:00Z' }));
    s.setAd(OWNER, 'new', track({ lastSeenAt: '2026-09-09T11:30:00Z' }));
    s.setAd(FRIEND, 'broken', track({ lastSeenAt: 'not-a-date' }));
    s.setAd(FRIEND, 'new', track({ lastSeenAt: '2026-09-09T11:30:00Z' }));
    const removed = s.pruneAds(24 * 3600 * 1000, now);
    expect(removed).toBe(2);
    expect(s.trackedAdCount).toBe(2);
    expect(s.trackedAdCountFor(OWNER)).toBe(1);
    expect(s.trackedAdCountFor(FRIEND)).toBe(1);
  });

  it('recovers from a corrupted state file', async () => {
    await writeFile(path.join(dir, 'state.json'), '{not json', 'utf8');
    const s = make();
    await s.load();
    expect(s.userIds()).toEqual([]);
    expect(s.trackedAdCount).toBe(0);
  });

  it('sanitises a damaged v2 file', async () => {
    await writeFile(
      path.join(dir, 'state.json'),
      JSON.stringify({ version: 2, users: { [OWNER]: { minRate: -5, ads: null } }, stats: {} }),
      'utf8',
    );
    const s = make();
    await s.load();
    expect(s.getMinRate(OWNER)).toBe(1.7);
    expect(s.trackedAdCountFor(OWNER)).toBe(0);
    expect(s.stats.totalChecks).toBe(0);
  });
});
