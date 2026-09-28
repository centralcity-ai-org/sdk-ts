import { hex, hmacSha256, randomToken, sha256Hex, utf8 } from '../internal/bytes.js';
import { revealed, type Secret } from '../secret.js';

/**
 * Native runtime request signing: lowercase hex HMAC-SHA256, keyed by the runtime
 * token, over `METHOD\npath\ntimestamp\nnonce\nsha256hex(body)`.
 *
 * - `path` is the request target exactly as sent. Only query-signed routes (the runtime inbox and
 *   mentions reads, and the signed stream) carry a query; build it once and sign those bytes.
 * - `timestamp` is 13-digit epoch milliseconds (±60 s at the server).
 * - `nonce` is single-use, `[A-Za-z0-9_-]{16,128}`; a fresh one for every attempt.
 * - The body hash covers the exact UTF-8 bytes sent; GET hashes the empty string.
 */
export interface RuntimeSignatureInput {
  token: Secret | string;
  method: string;
  path: string;
  body?: string;
  timestamp?: string;
  nonce?: string;
}

export const RUNTIME_NONCE = /^[A-Za-z0-9_-]{16,128}$/;

export async function runtimeSignature(input: RuntimeSignatureInput): Promise<{
  timestamp: string;
  nonce: string;
  signature: string;
}> {
  const timestamp = input.timestamp ?? String(Date.now());
  const nonce = input.nonce ?? randomToken(18);
  if (!/^\d{13}$/.test(timestamp)) throw new TypeError('timestamp must be 13-digit epoch ms.');
  if (!RUNTIME_NONCE.test(nonce)) throw new TypeError('nonce must match [A-Za-z0-9_-]{16,128}.');
  const digest = await sha256Hex(input.body ?? '');
  const canonical = [input.method.toUpperCase(), input.path, timestamp, nonce, digest].join('\n');
  const mac = await hmacSha256(utf8(revealed(input.token)), canonical);
  return { timestamp, nonce, signature: hex(mac) };
}

/** Headers for a signed runtime request (POST bodies must be sent as application/json). */
export async function runtimeHeaders(input: RuntimeSignatureInput): Promise<Record<string, string>> {
  const { timestamp, nonce, signature } = await runtimeSignature(input);
  return {
    Authorization: `Bearer ${revealed(input.token)}`,
    'Content-Type': 'application/json',
    'X-CC-Timestamp': timestamp,
    'X-CC-Nonce': nonce,
    'X-CC-Signature': signature,
  };
}
