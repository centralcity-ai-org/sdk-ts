/**
 * Heartbeat sequences must strictly increase. A store is durable and single-writer, and persists
 * the next value BEFORE it is sent (a value lost to a network failure is simply skipped). Workers
 * KV is not enough (no lock, eventually consistent): use a Durable Object or a database row with
 * compare-and-set. `@centralcity/sdk/node` has a file store.
 */
export interface SequenceStore {
  /** Persists and returns the next sequence number. */
  next(): Promise<number>;
  close?(): Promise<void>;
}

/** In memory, for tests and short-lived processes that enrolled just now. */
export function memorySequenceStore(start = -1): SequenceStore {
  let value = start;
  return {
    async next() {
      value += 1;
      if (!Number.isSafeInteger(value)) throw new Error('Sequence exhausted; rotate credentials.');
      return value;
    },
  };
}
