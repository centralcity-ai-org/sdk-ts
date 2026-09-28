import { LocalValidationError } from './errors.js';
import { highEntropyKey, newIdempotencyKey } from './idempotency.js';

/** One tool as listed by the server (generated into ./generated/tools.ts). */
export interface ToolInfo {
  properties: readonly string[];
  required: readonly string[];
  readOnly: boolean;
  /** false for tools that mint something new on every call (keys, invites, webhook secrets, asks). */
  idempotent: boolean;
}

/** Per endpoint: `open` is /mcp/open (anonymous or room credential), `mcp` is /mcp. */
export interface ToolTable {
  open: Readonly<Record<string, ToolInfo>>;
  mcp: Readonly<Record<string, ToolInfo>>;
}

/**
 * How the SDK may retry a tool.
 * - `safe`: keyed or read-only; retried after a network failure, a 5xx or a rate limit.
 * - `keyless`: state-setting without a key (ack, revoke, close, …); retried once, after a
 *   network failure only, and an error from that retry is marked `maybeApplied`.
 * - `never`: mints a secret (workspace key, invite, webhook secret); a lost response raises
 *   AmbiguousResultError instead of a retry.
 * - `ask`: city_ask; retried only on the server's own retryable codes.
 */
export type RetryClass = 'safe' | 'keyless' | 'never' | 'ask';

export interface ToolPolicy {
  keyField: 'idempotency_key' | 'idempotencyKey' | null;
  retry: RetryClass;
  /** The key must be unguessable (anonymous secret-issuing calls). */
  highEntropy: boolean;
}

/** Mint a secret or replace one on every call; a lost response is never retried. */
const NEVER = new Set([
  'city_create_workspace_key',
  'city_create_invite',
  'city_set_wake_webhook',
  'city_room_renew',
]);
/** Tools that return secrets once: the open endpoint's creation calls. */
const SECRET_ISSUING_OPEN = new Set(['city_create_workspace', 'city_create_agent', 'city_apply_team']);

export function policyFor(
  name: string,
  info: ToolInfo,
  context: { anonymous: boolean; args: Record<string, unknown> },
): ToolPolicy {
  if (name === 'city_ask') return { keyField: null, retry: 'ask', highEntropy: false };
  // Joining by invite is replay-safe with a key (the join is derived from it), although the tool
  // is not annotated idempotent: the key is optional on the wire, so the SDK always sends one.
  if (name === 'city_join_invite' && info.properties.includes('idempotency_key'))
    return { keyField: 'idempotency_key', retry: 'safe', highEntropy: true };
  if (NEVER.has(name) || !info.idempotent) return { keyField: null, retry: 'never', highEntropy: false };
  const legacyJob = name === 'city_create_job' || (name === 'city_create_agent' && 'name' in context.args);
  const keyField = legacyJob && info.properties.includes('idempotencyKey')
    ? 'idempotencyKey'
    : info.properties.includes('idempotency_key')
      ? 'idempotency_key'
      : null;
  // city_room_link takes a key only with rotate (a plain get is a read).
  if (name === 'city_room_link' && context.args.rotate !== true)
    return { keyField: null, retry: 'safe', highEntropy: false };
  if (info.readOnly) return { keyField: null, retry: 'safe', highEntropy: false };
  if (keyField) {
    return {
      keyField,
      retry: 'safe',
      highEntropy: context.anonymous && SECRET_ISSUING_OPEN.has(name),
    };
  }
  return { keyField: null, retry: 'keyless', highEntropy: false };
}

const RESERVED_JOB_PREFIXES = ['a2a:', 'workflow:', 'assistant:', 'xw:'];

/**
 * Applies the key rules before anything is sent. Returns the key, generating a
 * random UUID v4 when the caller did not pass one and the tool takes a key.
 */
export function resolveKey(
  name: string,
  policy: ToolPolicy,
  supplied: string | undefined,
  options: { dryRun: boolean },
): string | undefined {
  if (!policy.keyField) {
    if (supplied !== undefined)
      throw new LocalValidationError(`${name} takes no idempotency key.`);
    return undefined;
  }
  if (options.dryRun && supplied === undefined) return undefined;
  const key = supplied ?? newIdempotencyKey();
  if (key.length < 8 || key.length > 128)
    throw new LocalValidationError('An idempotency key has 8 to 128 characters.');
  if (name === 'city_create_job' && RESERVED_JOB_PREFIXES.some((prefix) => key.startsWith(prefix)))
    throw new LocalValidationError('That idempotency key prefix is reserved.');
  if (policy.highEntropy && !highEntropyKey(key))
    throw new LocalValidationError(
      'Anonymous creation needs an unguessable idempotency key: a fresh random UUID v4.',
    );
  return key;
}

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * Public camelCase arguments to the tool's own wire names, per tool: a property the
 * schema lists as written is kept (city_create_job takes camelCase), otherwise its snake_case form
 * is used. Unknown fields are refused locally, since every server schema is strict. Nested values
 * are passed through unchanged.
 */
export function toWire(name: string, info: ToolInfo, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const wire = info.properties.includes(key) ? key : snake(key);
    if (!info.properties.includes(wire))
      throw new LocalValidationError(`${name} has no field ${key}.`);
    out[wire] = value;
  }
  return out;
}
