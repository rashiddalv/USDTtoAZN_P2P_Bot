import { sleep } from './sleep.js';

/** Error that signals a transient failure (network, 5xx, 429, timeout). */
export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal | undefined;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Return true if the error should be retried. Default: only RetryableError. */
  shouldRetry?: (error: unknown) => boolean;
}

/**
 * Runs `fn` with exponential backoff + full jitter.
 * Delay after failed attempt n (1-based) = random(0, min(maxDelay, base * 2^(n-1))),
 * raised to the server-provided Retry-After hint when present.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const base = opts.baseDelayMs ?? 1_000;
  const max = opts.maxDelayMs ?? 30_000;
  const shouldRetry = opts.shouldRetry ?? ((e: unknown) => e instanceof RetryableError);
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    if (opts.signal?.aborted) throw new Error('Aborted');
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === opts.attempts || !shouldRetry(err)) throw err;
      const exp = Math.min(max, base * 2 ** (attempt - 1));
      const jittered = Math.floor(Math.random() * exp);
      const serverHint = err instanceof RetryableError ? (err.retryAfterMs ?? 0) : 0;
      const delay = Math.min(max, Math.max(jittered, serverHint));
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay, opts.signal);
    }
  }
  throw lastError;
}
