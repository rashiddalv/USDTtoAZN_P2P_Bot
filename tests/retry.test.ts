import { describe, expect, it, vi } from 'vitest';
import { RetryableError, withRetry } from '../src/utils/retry.js';

describe('withRetry', () => {
  it('retries retryable errors with growing delays and eventually succeeds', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const delays: number[] = [];
    let n = 0;
    const result = await withRetry(
      async () => {
        n++;
        if (n < 3) throw new RetryableError('boom');
        return 'ok';
      },
      { attempts: 3, baseDelayMs: 10, maxDelayMs: 1_000, onRetry: (_e, _a, d) => delays.push(d) },
    );
    vi.restoreAllMocks();
    expect(result).toBe('ok');
    expect(delays).toHaveLength(2);
    expect(delays[1]!).toBeGreaterThanOrEqual(delays[0]!);
  });

  it('does not retry non-retryable errors', async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new Error('fatal');
        },
        { attempts: 5, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('fatal');
    expect(n).toBe(1);
  });

  it('honours retryAfter hint from the error', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const delays: number[] = [];
    let n = 0;
    await withRetry(
      async () => {
        n++;
        if (n === 1) throw new RetryableError('429', 25);
        return n;
      },
      { attempts: 2, baseDelayMs: 1, onRetry: (_e, _a, d) => delays.push(d) },
    );
    vi.restoreAllMocks();
    expect(delays).toEqual([25]);
  });
});
