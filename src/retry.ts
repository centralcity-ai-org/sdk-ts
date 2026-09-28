import {
  AmbiguousResultError,
  CentralCityError,
  TransportError,
  markMaybeApplied,
} from './errors.js';
import type { RetryClass } from './table.js';

/** Three attempts or 30 s, jittered exponential backoff from 1 s capped at 15 s. */
export interface RetryPolicy {
  maxAttempts: number;
  totalMs: number;
  baseMs: number;
  capMs: number;
}

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  totalMs: 30_000,
  baseMs: 1_000,
  capMs: 15_000,
};

export interface RetryEnvironment {
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  signal?: AbortSignal;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Full-jitter backoff for attempt n (1-based), never below the server's retry-after. */
export function backoffMs(
  attempt: number,
  policy: RetryPolicy,
  random: () => number,
  retryAfterMs?: number,
): number {
  const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** (attempt - 1));
  const jittered = Math.round(ceiling / 2 + (random() * ceiling) / 2);
  return Math.max(jittered, retryAfterMs ?? 0);
}

function retriable(cls: RetryClass, error: unknown, attempt: number): boolean {
  if (error instanceof TransportError)
    return cls === 'safe' || (cls === 'keyless' && attempt === 1);
  if (error instanceof CentralCityError) {
    if (cls === 'safe') return error.kind === 'server' || error.kind === 'rate_limit';
    // city_ask: only the server's own retryable codes (ask_timeout, rate_limited), after waiting.
    if (cls === 'ask') return error.kind === 'rate_limit';
  }
  return false;
}

/**
 * Runs `attempt` under the tool's retry class. A never-retried tool turns a transport failure
 * into AmbiguousResultError; a keyless tool's error after its one retry is marked maybeApplied.
 */
export async function withRetry<T>(
  tool: string,
  cls: RetryClass,
  attempt: (n: number) => Promise<T>,
  policy: RetryPolicy = defaultRetryPolicy,
  env: RetryEnvironment = {},
): Promise<T> {
  const now = env.now ?? Date.now;
  const sleep = env.sleep ?? abortableSleep;
  const random = env.random ?? Math.random;
  const started = now();
  let retried = false;
  for (let n = 1; ; n++) {
    try {
      return await attempt(n);
    } catch (error) {
      if (env.signal?.aborted) throw error;
      if (cls === 'never' && error instanceof TransportError)
        throw new AmbiguousResultError(tool, error);
      if (retried && cls === 'keyless' && error instanceof CentralCityError)
        throw markMaybeApplied(error);
      if (n >= policy.maxAttempts || !retriable(cls, error, n)) throw error;
      const wait = backoffMs(
        n,
        policy,
        random,
        error instanceof CentralCityError ? error.retryAfterMs : undefined,
      );
      // Surface the error rather than sleep past the budget.
      if (now() - started + wait > policy.totalMs) throw error;
      await sleep(wait, env.signal);
      retried = true;
    }
  }
}
