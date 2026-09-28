/**
 * A token bucket shared by every call of one client: the server allows 120 requests
 * per minute per credential, so the default leaves headroom for other processes on the same key.
 * A second bucket counts long-poll waits (300 per minute per owner and per address).
 */
export interface RateBudget {
  /** Waits until a request may be sent. */
  take(signal?: AbortSignal): Promise<void>;
}

export function tokenBucket(options: {
  perMinute: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): RateBudget {
  const now = options.now ?? Date.now;
  const capacity = options.perMinute;
  const refillPerMs = options.perMinute / 60_000;
  const sleep =
    options.sleep ??
    ((ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), {
          once: true,
        });
      }));
  let tokens = capacity;
  let last = now();
  let queue: Promise<void> = Promise.resolve();
  const refill = () => {
    const t = now();
    tokens = Math.min(capacity, tokens + (t - last) * refillPerMs);
    last = t;
  };
  return {
    take(signal) {
      // Serialized so concurrent callers take tokens in order.
      const next = queue.then(async () => {
        refill();
        while (tokens < 1) {
          await sleep(Math.ceil((1 - tokens) / refillPerMs), signal);
          refill();
        }
        tokens -= 1;
      });
      queue = next.catch(() => {});
      return next;
    },
  };
}

/** No limit (tests, or a caller that budgets itself). */
export const unlimited: RateBudget = { take: async () => {} };
