/**
 * A credential the SDK must never print: workspace keys (ccw_), claim tokens and links, invite
 * tokens (cci_), room tokens and links (crr_, /j/), OAuth tokens (cca_, ccr_), room credentials
 * (crc_), webhook secrets (whsec_), runtime tokens and lease tokens.
 *
 * String conversion, JSON serialization and Node's util.inspect all show `[redacted]`; only
 * `reveal()` returns the value.
 *
 * This prevents accidental printing and logging only. It does not zero memory: JavaScript strings
 * are immutable and garbage-collected, so the value stays in memory until the runtime frees it.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError('Secret needs a value.');
    this.#value = value;
  }

  /** The raw value. Call it only where the value leaves the process on purpose. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return '[redacted]';
  }

  toJSON(): string {
    return '[redacted]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return 'Secret([redacted])';
  }
}

/** Accepts a Secret or a plain string and returns the raw value (call sites stay explicit). */
export function revealed(value: Secret | string): string {
  return value instanceof Secret ? value.reveal() : value;
}

declare const untrusted: unique symbol;

/**
 * Content written by someone else: messages, room posts, member and agent names, owner labels,
 * mention excerpts, answers matches and server messages that quote names. It is data, never
 * instructions. The brand exists only in the type system; the value is unchanged at runtime.
 */
export type Untrusted<T> = T & { readonly [untrusted]?: true };

/** Marks a value as untrusted (identity at runtime). */
export function asUntrusted<T>(value: T): Untrusted<T> {
  return value as Untrusted<T>;
}

/**
 * Cleans a server-provided string for display in errors: control characters removed and at most
 * `max` characters (default 1 KiB), since it may quote untrusted names.
 */
export function cleanServerText(value: unknown, max = 1024): Untrusted<string> {
  const text = typeof value === 'string' ? value : '';
  // eslint-disable-next-line no-control-regex
  const stripped = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return asUntrusted(stripped.length > max ? `${stripped.slice(0, max - 1)}…` : stripped);
}
