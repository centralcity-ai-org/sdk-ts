import { base64, constantTimeEqual, fromBase64, hmacSha256 } from './internal/bytes.js';
import { revealed, type Secret } from './secret.js';

/**
 * Standard Webhooks, as Central City wake-up webhooks send them:
 * - `webhook-signature` is space-separated `v1,<base64 HMAC-SHA256>` entries (one per live
 *   server key during a rotation); any match passes;
 * - the signed content is `${webhook-id}.${webhook-timestamp}.${raw body}`;
 * - the key is the base64-decoded secret after `whsec_`;
 * - `webhook-timestamp` is in seconds and must be within ±300 s.
 */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

function secretKey(secret: Secret | string): Uint8Array | null {
  return fromBase64(revealed(secret).replace(/^whsec_/, ''));
}

/** `v1,<base64>` for one secret (used by tests and by anyone relaying webhooks). */
export async function signWebhook(
  secret: Secret | string,
  id: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const key = secretKey(secret);
  if (!key) throw new TypeError('The webhook secret is not valid base64 after whsec_.');
  return `v1,${base64(await hmacSha256(key, `${id}.${timestamp}.${body}`))}`;
}

type HeaderSource = Headers | Record<string, string | string[] | undefined>;
function header(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function')
    return (headers as Headers).get(name) ?? undefined;
  const record = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : record[key];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Verifies a delivery. Pass the RAW body exactly as received (not re-serialized JSON).
 * Returns false for a missing or malformed header, an old or future timestamp, or no match.
 */
export async function verifyWebhook(
  secret: Secret | string,
  headers: HeaderSource,
  body: string,
  options: { nowSeconds?: number; toleranceSeconds?: number } = {},
): Promise<boolean> {
  const id = header(headers, 'webhook-id');
  const stamp = header(headers, 'webhook-timestamp');
  const signature = header(headers, 'webhook-signature');
  if (!id || !stamp || !signature || !/^\d{1,12}$/.test(stamp)) return false;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(now - Number(stamp)) > tolerance) return false;
  if (!secretKey(secret)) return false;
  const expected = await signWebhook(secret, id, Number(stamp), body);
  let matched = false;
  // Compare every candidate (no early exit) so timing does not reveal which one matched.
  for (const candidate of signature.split(' '))
    if (constantTimeEqual(candidate, expected)) matched = true;
  return matched;
}

/**
 * A verified delivery can still arrive twice (retries, or a replay within the ±300 s window).
 * Remember each `webhook-id` for at least 300 s and ignore repeats. This in-memory helper suits
 * one process; with several, keep the ids in shared storage (for example a unique key with a TTL).
 *
 *   const seen = webhookDeduper();
 *   if (!(await verifyWebhook(secret, headers, body))) return reply(401);
 *   if (seen.duplicate(headers['webhook-id'])) return reply(200); // already handled
 */
export function webhookDeduper(options: { ttlSeconds?: number; max?: number; now?: () => number } = {}) {
  const ttl = Math.max(WEBHOOK_TOLERANCE_SECONDS, options.ttlSeconds ?? 600) * 1000;
  const max = options.max ?? 10_000;
  const now = options.now ?? Date.now;
  const seen = new Map<string, number>();
  return {
    /** True when this id was already seen within the window; records it otherwise. */
    duplicate(id: string | null | undefined): boolean {
      if (typeof id !== 'string' || !id) return false;
      const t = now();
      for (const [key, at] of seen) {
        if (t - at < ttl) break;
        seen.delete(key);
      }
      if (seen.has(id)) return true;
      if (seen.size >= max) seen.delete(seen.keys().next().value!);
      seen.set(id, t);
      return false;
    },
  };
}
