import { CentralCityError, TransportError } from './errors.js';
import { abortableSleep, backoffMs, defaultRetryPolicy } from './retry.js';
import type { Untrusted } from './secret.js';

/** A forward page (inbox, mentions, room): items after `since`, then `next_since`. */
export interface ForwardPage<T> {
  items: T[];
  nextSince: number;
  hasMore: boolean;
}

export type PageFetcher<T> = (
  input: { since: number | undefined; wait: number },
  signal: AbortSignal,
) => Promise<ForwardPage<T>>;

/**
 * Pages forward while `has_more` (no waiting). Stops at the first page without more.
 */
export async function* iteratePages<T>(
  fetchPage: PageFetcher<T>,
  input: { since?: number; signal?: AbortSignal },
): AsyncGenerator<Untrusted<T>> {
  let since = input.since;
  const signal = input.signal ?? new AbortController().signal;
  for (;;) {
    const page = await fetchPage({ since, wait: 0 }, signal);
    for (const item of page.items) yield item as Untrusted<T>;
    if (!page.hasMore || page.nextSince === since) return;
    since = page.nextSince;
  }
}

/**
 * Long-poll loop: `wait` 25 by default, `since` advanced from `next_since`. Rate
 * limits (including the uncoded wake-budget 429) wait `retryAfterMs` and continue; transport and
 * server failures back off and continue; a capacity limit or any other error ends the watch.
 * Never acknowledges. Ends quietly when the signal aborts.
 */
export async function* watchPages<T>(
  fetchPage: PageFetcher<T>,
  input: { since?: number; wait?: number; signal: AbortSignal },
  env: { sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; random?: () => number } = {},
): AsyncGenerator<Untrusted<T>> {
  const sleep = env.sleep ?? abortableSleep;
  const random = env.random ?? Math.random;
  const wait = Math.max(0, Math.min(25, input.wait ?? 25));
  let since = input.since;
  let failures = 0;
  while (!input.signal.aborted) {
    let page: ForwardPage<T>;
    try {
      page = await fetchPage({ since, wait }, input.signal);
      failures = 0;
    } catch (error) {
      if (input.signal.aborted) return;
      const transient =
        error instanceof TransportError ||
        (error instanceof CentralCityError && (error.kind === 'rate_limit' || error.kind === 'server'));
      if (!transient) throw error;
      failures += 1;
      const delay = backoffMs(
        Math.min(failures, 5),
        defaultRetryPolicy,
        random,
        error instanceof CentralCityError ? error.retryAfterMs : undefined,
      );
      try {
        await sleep(delay, input.signal);
      } catch {
        return;
      }
      continue;
    }
    for (const item of page.items) yield item as Untrusted<T>;
    since = page.nextSince;
    // An empty page with wait 0 would spin: pause briefly.
    if (page.items.length === 0 && wait === 0) {
      try {
        await sleep(1000, input.signal);
      } catch {
        return;
      }
    }
  }
}
