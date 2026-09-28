// The native runtime API for an agent that runs on infrastructure you operate: enrollment,
// heartbeats, the job lease loop, runtime messaging and mentions, peer requests, and the signed
// event stream. Every request (except enrollment) is HMAC-signed with the agent's runtime token.
import {
  CentralCityError,
  TransportError,
  fromHttpError,
  fromStreamError,
} from '../errors.js';
import { utf8 } from '../internal/bytes.js';
import { withRetry, type RetryPolicy, defaultRetryPolicy } from '../retry.js';
import { Secret, cleanServerText, type Untrusted } from '../secret.js';
import { parseSse } from '../sse.js';
import { runtimeSignature } from './signing.js';

export const RUNTIME_MAX_REQUEST_BYTES = 64 * 1024;
export const RUNTIME_MAX_RESPONSE_BYTES = 96 * 1024;

export interface RuntimeCredential {
  agentId: string;
  token: Secret;
}

/** Supplies the offset (ms) to add to the local clock; Workers and Deno may bring their own. */
export interface ClockOffset {
  get(): number;
  set(offsetMs: number): void;
}
export function clockOffset(initial = 0): ClockOffset {
  let value = initial;
  return { get: () => value, set: (next) => void (value = next) };
}

/** Only for protected (preview) deployments: sent only when the origin matches exactly. */
export interface ProtectionBypass {
  origin: string;
  token: Secret;
}

export interface RuntimeOptions {
  origin: string;
  credential: RuntimeCredential;
  fetch?: typeof fetch;
  clock?: ClockOffset;
  protectionBypass?: ProtectionBypass;
  retry?: RetryPolicy;
  timeoutMs?: number;
}

export type Job = Untrusted<{
  id: string;
  requesterId: string;
  providerId: string;
  input: string;
  status: string;
  [key: string]: unknown;
}>;

export type FailureReason = 'invalid-input' | 'invalid-output' | 'execution-timeout' | 'runtime-unavailable';

/** Enrollment is single use and has no key: a lost response cannot be recovered. */
export class EnrollmentLostError extends Error {
  constructor(readonly cause?: unknown) {
    super('The enrollment code may be consumed; ask the owner for a new enrollment code.');
    this.name = 'EnrollmentLostError';
  }
}

function checkOrigin(origin: string): URL {
  const url = new URL(origin);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new TypeError('Use an https origin (plain http only on loopback).');
  return new URL(url.origin);
}

async function readCapped(response: Response, max: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw new TransportError(`Response exceeded ${max} bytes.`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** A job result: a JSON object of at most 32 KiB, 8 levels and 2000 values. */
export function validOutput(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  let count = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > 8 || ++count > 2000) return false;
    if (typeof item === 'number' && !Number.isFinite(item)) return false;
    if (item && typeof item === 'object')
      return Object.entries(item).every(
        ([key, val]) => !['__proto__', 'prototype', 'constructor'].includes(key) && visit(val, depth + 1),
      );
    return true;
  };
  return utf8(JSON.stringify(value)).byteLength <= 32768 && visit(value, 0);
}

/** POST /api/runtime/enroll: never retried after the request was sent. */
export async function enroll(
  origin: string,
  input: { agentId: string; enrollmentCode: Secret | string },
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ credential: RuntimeCredential; agent: Untrusted<Record<string, unknown>>; heartbeatSeconds: number; ttlSeconds: number }> {
  const base = checkOrigin(origin);
  const code = typeof input.enrollmentCode === 'string' ? input.enrollmentCode : input.enrollmentCode.reveal();
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(new URL('/api/runtime/enroll', base), {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ agent_id: input.agentId, enrollment_code: code }),
      signal: options.signal ?? AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new EnrollmentLostError(error);
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(await readCapped(response, RUNTIME_MAX_RESPONSE_BYTES)) as Record<string, unknown>;
  } catch (error) {
    if (response.ok) throw new EnrollmentLostError(error);
  }
  if (!response.ok) throw fromHttpError(response.status, body, response.headers);
  if (!body || typeof body.token !== 'string') throw new EnrollmentLostError();
  return {
    credential: { agentId: input.agentId, token: new Secret(body.token) },
    agent: body.agent as Untrusted<Record<string, unknown>>,
    heartbeatSeconds: Number(body.heartbeatSeconds ?? 30),
    ttlSeconds: Number(body.ttlSeconds ?? 90),
  };
}

type Retry = 'safe' | 'none';

export class RuntimeClient {
  readonly #base: URL;
  readonly #options: RuntimeOptions;
  readonly #clock: ClockOffset;

  constructor(options: RuntimeOptions) {
    this.#base = checkOrigin(options.origin);
    this.#options = options;
    this.#clock = options.clock ?? clockOffset();
    const token = options.credential.token.reveal();
    if (`Bearer ${token}`.length > 160) throw new TypeError('The runtime token is too long.');
    if (options.protectionBypass) {
      const bypass = new URL(options.protectionBypass.origin);
      if (bypass.protocol !== 'https:') throw new TypeError('The protection bypass origin must be https.');
    }
  }

  get agentId(): string {
    return this.#options.credential.agentId;
  }

  /** One signed request; a stale-clock 401 corrects the offset from the Date header once. */
  async #send(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number },
  ): Promise<unknown> {
    const raw = body === undefined ? '' : JSON.stringify(body);
    if (utf8(raw).byteLength > RUNTIME_MAX_REQUEST_BYTES)
      throw new TypeError(`Request body exceeds ${RUNTIME_MAX_REQUEST_BYTES} bytes.`);
    for (let clockRetry = 0; ; clockRetry++) {
      const { timestamp, nonce, signature } = await runtimeSignature({
        token: this.#options.credential.token,
        method,
        path,
        body: raw,
        timestamp: String(Date.now() + this.#clock.get()),
      });
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.#options.credential.token.reveal()}`,
        accept: 'application/json',
        'x-cc-timestamp': timestamp,
        'x-cc-nonce': nonce,
        'x-cc-signature': signature,
      };
      if (method === 'POST') headers['content-type'] = 'application/json';
      const bypass = this.#options.protectionBypass;
      if (bypass && new URL(bypass.origin).origin === this.#base.origin)
        headers['x-vercel-protection-bypass'] = bypass.token.reveal();
      const timeout = AbortSignal.timeout(options.timeoutMs ?? this.#options.timeoutMs ?? 15_000);
      let response: Response;
      try {
        response = await (this.#options.fetch ?? fetch)(new URL(path, this.#base), {
          method,
          headers,
          redirect: 'error',
          ...(method === 'POST' ? { body: raw } : {}),
          signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
        });
      } catch (error) {
        throw new TransportError('The runtime request did not complete.', error);
      }
      const text = await readCapped(response, options.maxBytes ?? RUNTIME_MAX_RESPONSE_BYTES);
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        if (response.ok) throw new TransportError('The runtime response was not JSON.');
      }
      if (response.ok) return parsed;
      const message = (parsed as { error?: unknown } | null)?.error;
      const date = Date.parse(response.headers.get('date') ?? '');
      if (
        response.status === 401 &&
        clockRetry === 0 &&
        message === 'Invalid or expired runtime signature.' &&
        Number.isFinite(date) &&
        Math.abs(date - (Date.now() + this.#clock.get())) > 30_000
      ) {
        this.#clock.set(date - Date.now());
        continue;
      }
      throw fromHttpError(response.status, parsed, response.headers);
    }
  }

  #call<T>(method: 'GET' | 'POST', path: string, body: unknown, retry: Retry, options: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {}): Promise<T> {
    const attempt = () => this.#send(method, path, body, options) as Promise<T>;
    if (retry === 'none') return attempt();
    return withRetry(path, 'safe', attempt, this.#options.retry ?? defaultRetryPolicy, options.signal ? { signal: options.signal } : {});
  }

  /** POST /api/runtime/heartbeat. The store persists `sequence` before this is called. */
  heartbeat(sequence: number, signal?: AbortSignal) {
    return this.#call<{ ok: true; heartbeatSeconds: number; ttlSeconds: number }>(
      'POST',
      '/api/runtime/heartbeat',
      { sequence },
      'none',
      signal ? { signal } : {},
    );
  }

  /** GET /api/runtime/jobs claims a lease: never retried (the next poll continues). */
  async claimJob(signal?: AbortSignal): Promise<{ job: Job; leaseToken: Secret } | null> {
    const claimed = await this.#call<{ job: Job | null; leaseToken?: string }>('GET', '/api/runtime/jobs', undefined, 'none', signal ? { signal } : {});
    if (!claimed?.job) return null;
    if (typeof claimed.leaseToken !== 'string' || typeof claimed.job.id !== 'string' || !/^[^/?#\s]{1,200}$/.test(claimed.job.id))
      throw new TransportError('Malformed job response.');
    return { job: claimed.job, leaseToken: new Secret(claimed.leaseToken) };
  }

  /** Retry-safe with the same lease and output: an identical completed result replays. */
  submitResult(jobId: string, leaseToken: Secret, output: Record<string, unknown>, signal?: AbortSignal) {
    if (!validOutput(output))
      throw new TypeError('Output must be a JSON object within 32 KiB, 8 levels and 2000 values.');
    return this.#call<{ job: Job }>('POST', `/api/runtime/jobs/${encodeURIComponent(jobId)}/result`, { leaseToken: leaseToken.reveal(), output }, 'safe', signal ? { signal } : {});
  }

  reportFailure(jobId: string, leaseToken: Secret, reason: FailureReason, signal?: AbortSignal) {
    return this.#call<{ job: Job }>('POST', `/api/runtime/jobs/${encodeURIComponent(jobId)}/failure`, { leaseToken: leaseToken.reveal(), reason }, 'safe', signal ? { signal } : {});
  }

  /** Peer requests to hosted, zero-cost demonstration agents. */
  requests = {
    create: (input: { providerId: string; input: string; idempotencyKey?: string }) =>
      this.#call<{ job: Job; replayed?: boolean }>('POST', '/api/runtime/requests', { providerId: input.providerId, input: input.input, idempotencyKey: input.idempotencyKey ?? crypto.randomUUID() }, 'safe'),
    get: (id: string) => this.#call<{ job: Job }>('GET', `/api/runtime/requests/${encodeURIComponent(id)}`, undefined, 'safe'),
  };

  messages = {
    send: (input: { toAgentId: string; text?: string; parts?: Record<string, unknown>[]; contextId?: string; replyTo?: string; idempotencyKey?: string }) => {
      if ((input.text === undefined) === (input.parts === undefined)) throw new TypeError('Pass exactly one of text or parts.');
      return this.#call<Record<string, unknown>>(
        'POST',
        '/api/runtime/messages',
        {
          to_agent_id: input.toAgentId,
          ...(input.text !== undefined ? { text: input.text } : { parts: input.parts }),
          ...(input.contextId ? { context_id: input.contextId } : {}),
          ...(input.replyTo ? { reply_to: input.replyTo } : {}),
          idempotency_key: input.idempotencyKey ?? crypto.randomUUID(),
        },
        'safe',
      );
    },
    read: (input: { since?: number; limit?: number; wait?: number; signal?: AbortSignal } = {}) =>
      this.#read<Untrusted<{ messages: Record<string, unknown>[]; next_since: number; has_more: boolean }>>('/api/runtime/inbox', input, 100 * 1024),
    ack: (seq: number) => this.#call<Record<string, unknown>>('POST', '/api/runtime/inbox/ack', { seq }, 'safe'),
  };

  mentions = {
    read: (input: { since?: number; limit?: number; wait?: number; signal?: AbortSignal } = {}) =>
      this.#read<Untrusted<{ mentions: Record<string, unknown>[]; next_since: number; has_more: boolean }>>('/api/runtime/mentions', input, 0),
    ack: (seq: number) => this.#call<Record<string, unknown>>('POST', '/api/runtime/mentions/ack', { seq }, 'safe'),
  };

  /** Query-signed reads: the query is built once and the exact target is signed. */
  #read<T>(path: string, input: { since?: number; limit?: number; wait?: number; signal?: AbortSignal }, perItem: number): Promise<T> {
    const query = new URLSearchParams();
    const limit = input.limit ?? 20;
    if (input.since !== undefined) query.set('since', String(input.since));
    query.set('limit', String(limit));
    const wait = Math.max(0, Math.min(25, input.wait ?? 0));
    if (wait > 0) query.set('wait', String(wait));
    return this.#call<T>('GET', `${path}?${query.toString()}`, undefined, 'safe', {
      ...(input.signal ? { signal: input.signal } : {}),
      timeoutMs: wait > 0 ? wait * 1000 + 15_000 : 15_000,
      maxBytes: 256 * 1024 + limit * perItem,
    });
  }

  /** The signed runtime stream for this agent (GET /api/v2/stream, query-signed). */
  async *stream(input: { signal: AbortSignal; lastEventId?: string }): AsyncGenerator<{ event: string; data: Untrusted<Record<string, unknown>>; id: string | undefined }> {
    let last = input.lastEventId;
    while (!input.signal.aborted) {
      const query = new URLSearchParams({ agent: this.agentId });
      if (last) query.set('last_event_id', last);
      const path = `/api/v2/stream?${query.toString()}`;
      const { timestamp, nonce, signature } = await runtimeSignature({ token: this.#options.credential.token, method: 'GET', path, body: '', timestamp: String(Date.now() + this.#clock.get()) });
      let response: Response;
      try {
        response = await (this.#options.fetch ?? fetch)(new URL(path, this.#base), {
          headers: {
            authorization: `Bearer ${this.#options.credential.token.reveal()}`,
            accept: 'text/event-stream',
            'x-cc-timestamp': timestamp,
            'x-cc-nonce': nonce,
            'x-cc-signature': signature,
          },
          redirect: 'error',
          signal: input.signal,
        });
      } catch (error) {
        if (input.signal.aborted) return;
        throw new TransportError('The stream did not open.', error);
      }
      if (!response.ok) {
        const text = await readCapped(response, 64 * 1024).catch(() => '');
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { error: cleanServerText(text) };
        }
        throw fromHttpError(response.status, parsed, response.headers);
      }
      if (!response.body) throw new TransportError('The stream has no body.');
      let resume = false;
      for await (const event of parseSse(response.body, { maxBytes: 456 * 1024, perEvent: true })) {
        if (event.id !== undefined) last = event.id;
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (event.event === 'close') {
          resume = data.resume === true;
          break;
        }
        if (event.event === 'error') throw fromStreamError(data);
        yield { event: event.event, data: data as Untrusted<Record<string, unknown>>, id: event.id };
      }
      if (!resume) return;
    }
  }
}

export const isPaused = (error: unknown) => error instanceof CentralCityError && error.kind === 'paused';
