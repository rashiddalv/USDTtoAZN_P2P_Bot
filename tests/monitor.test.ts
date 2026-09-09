import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Monitor, type MonitorOptions } from '../src/monitor/monitor.js';
import type { P2PAd, P2PAdsProvider } from '../src/services/binanceP2P.types.js';
import { StateStore } from '../src/storage/stateStore.js';

const logger = pino({ level: 'silent' });
const OWNER = 111;
const FRIEND = 222;
const STRANGER = 333;
let dir: string;

function ad(id: string, price: number): P2PAd {
  return {
    id,
    asset: 'USDT',
    fiat: 'AZN',
    price,
    availableAsset: 100,
    minFiat: 50,
    maxFiat: 500,
    payTimeLimitMin: 15,
    advertiser: {
      userNo: `u-${id}`,
      nickName: `nick-${id}`,
      completionRate: 0.99,
      positiveRate: 0.98,
      monthOrderCount: 10,
      isMerchant: false,
    },
    paymentMethods: ['M10'],
    advertiserUrl: 'https://example.test/a',
    advertiserAppUrl: 'https://example.test/app-a',
    marketUrl: 'https://example.test/m',
    marketAppUrl: 'https://example.test/app-m',
  };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'p2p-monitor-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function setup(ads: P2PAd[]) {
  const store = new StateStore(dir, { defaultMinRate: 1.7, primaryUserId: OWNER }, logger);
  await store.load();
  const fetchBuyerAds = vi.fn<P2PAdsProvider['fetchBuyerAds']>(async () => ads);
  const provider: P2PAdsProvider = { fetchBuyerAds };
  const onNewMatches = vi.fn<MonitorOptions['onNewMatches']>(async () => undefined);
  const monitor = new Monitor({
    provider,
    store,
    logger,
    pollIntervalMs: 60_000,
    notifiedTtlMs: 3_600_000,
    maxPages: 3,
    defaultMinRate: 1.7,
    allowedUserIds: [OWNER, FRIEND],
    onNewMatches,
  });
  return { store, monitor, fetchBuyerAds, onNewMatches };
}

describe('Monitor (multi-user)', () => {
  it('fetches down to the lowest threshold and notifies each user by their own threshold', async () => {
    const ads = [ad('a', 1.72), ad('b', 1.68), ad('c', 1.6)];
    const { store, monitor, fetchBuyerAds, onNewMatches } = await setup(ads);
    store.ensureUser(OWNER);
    store.ensureUser(FRIEND);
    store.setMinRate(OWNER, 1.7);
    store.setMinRate(FRIEND, 1.65);

    const result = await monitor.checkNow();

    expect(fetchBuyerAds).toHaveBeenCalledTimes(1);
    expect(fetchBuyerAds.mock.calls[0]?.[0]?.minPrice).toBe(1.65);
    expect(result.fetchMinRate).toBe(1.65);
    expect(result.users.get(OWNER)?.matches.map((a) => a.id)).toEqual(['a']);
    expect(result.users.get(FRIEND)?.matches.map((a) => a.id)).toEqual(['a', 'b']);

    expect(onNewMatches).toHaveBeenCalledTimes(2);
    const byUser = new Map(onNewMatches.mock.calls.map((c) => [c[0], c]));
    expect(byUser.get(OWNER)?.[1].map((a) => a.id)).toEqual(['a']);
    expect(byUser.get(OWNER)?.[2]).toBe(1.7);
    expect(byUser.get(FRIEND)?.[1].map((a) => a.id)).toEqual(['a', 'b']);
    expect(byUser.get(FRIEND)?.[2]).toBe(1.65);

    expect(store.getUser(OWNER)?.totalNotifications).toBe(1);
    expect(store.getUser(FRIEND)?.totalNotifications).toBe(2);
    expect(store.getUser(OWNER)?.lastMatchCount).toBe(1);
    expect(store.getUser(FRIEND)?.lastMatchCount).toBe(2);
    expect(store.stats.totalChecks).toBe(1);
    expect(store.stats.bestPriceSeen).toBe(1.72);

    // Second identical check: nothing new for anyone.
    onNewMatches.mockClear();
    await monitor.checkNow();
    expect(onNewMatches).not.toHaveBeenCalled();
  });

  it('ignores users not registered yet and users removed from the allow-list', async () => {
    const { store, monitor, onNewMatches } = await setup([ad('a', 1.72)]);
    store.ensureUser(OWNER);
    store.ensureUser(STRANGER); // in the store, but not allowed any more
    const result = await monitor.checkNow();
    expect([...result.users.keys()]).toEqual([OWNER]);
    expect(onNewMatches).toHaveBeenCalledTimes(1);
    expect(onNewMatches.mock.calls[0]?.[0]).toBe(OWNER);
  });

  it('uses the default rate when nobody has registered', async () => {
    const { monitor, fetchBuyerAds, onNewMatches } = await setup([ad('a', 1.72)]);
    const result = await monitor.checkNow();
    expect(fetchBuyerAds.mock.calls[0]?.[0]?.minPrice).toBe(1.7);
    expect(result.users.size).toBe(0);
    expect(onNewMatches).not.toHaveBeenCalled();
  });

  it('retries only the user whose delivery failed', async () => {
    const { store, monitor, onNewMatches } = await setup([ad('a', 1.72)]);
    store.ensureUser(OWNER);
    store.ensureUser(FRIEND);
    onNewMatches.mockImplementation(async (userId) => {
      if (userId === FRIEND) throw new Error('telegram down');
    });
    await monitor.checkNow();
    expect(store.getUser(OWNER)?.totalNotifications).toBe(1);
    expect(store.getUser(FRIEND)?.totalNotifications).toBe(0);
    expect(store.getAd(FRIEND, 'a')?.lastAbove).toBe(false);

    onNewMatches.mockClear();
    onNewMatches.mockImplementation(async () => undefined);
    await monitor.checkNow();
    expect(onNewMatches).toHaveBeenCalledTimes(1);
    expect(onNewMatches.mock.calls[0]?.[0]).toBe(FRIEND);
    expect(store.getUser(FRIEND)?.totalNotifications).toBe(1);
  });

  it('a raised threshold is applied on the next check and re-notifies on re-crossing', async () => {
    const { store, monitor, onNewMatches } = await setup([ad('a', 1.72)]);
    store.ensureUser(OWNER);
    await monitor.checkNow();
    expect(onNewMatches).toHaveBeenCalledTimes(1);

    store.setMinRate(OWNER, 1.75);
    await monitor.checkNow();
    expect(onNewMatches).toHaveBeenCalledTimes(1); // no longer matches, nothing sent

    store.setMinRate(OWNER, 1.7);
    await monitor.checkNow();
    expect(onNewMatches).toHaveBeenCalledTimes(2); // crossed again from below
  });
});
