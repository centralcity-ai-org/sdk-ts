// GET /api/v2/stream: a fetch-based SSE client that sends Authorization, never an
// Origin header, resumes with Last-Event-ID, and falls back to long-polls on stream_limit.
import type { CentralCity } from './client.js';
import { CentralCityError, TransportError, fromHttpError, fromStreamError } from './errors.js';
import { abortableSleep, backoffMs, defaultRetryPolicy } from './retry.js';
import type { Untrusted } from './secret.js';
import { parseSse } from './sse.js';

export type StreamEvent =
  | { event: 'ready'; data: Untrusted<Record<string, unknown>>; id: string | undefined }
  | { event: 'message' | 'mention' | 'room_post'; data: Untrusted<Record<string, unknown>>; id: string | undefined }
  | { event: 'fallback'; data: { reason: 'stream_limit'; until: number }; id: undefined };

/** One event holds at most one single-message page. */
const EVENT_CAP = 256 * 1024 + 200 * 1024;
const FALLBACK_MS = 60_000;

export interface StreamOptions {
  agentId: string;
  signal: AbortSignal;
  lastEventId?: string;
  workspaceId?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Yields inbox messages, mentions and room posts for one agent until the signal aborts.
 * On `429 stream_limit` it yields one `fallback` event, then long-polls inbox and mentions for
 * 60 s (room posts are not covered by the fallback: watch those rooms directly), then retries.
 */
export async function* stream(
  client: CentralCity,
  options: StreamOptions,
): AsyncGenerator<StreamEvent> {
  const sleep = options.sleep ?? abortableSleep;
  const fetchImpl = options.fetch ?? fetch;
  let lastEventId = options.lastEventId;
  let failures = 0;
  const cursors: { inbox?: number; mention?: number } = {};
  while (!options.signal.aborted) {
    const url = new URL('/api/v2/stream', client.origin);
    url.searchParams.set('agent', options.agentId);
    if (options.workspaceId) url.searchParams.set('workspace', options.workspaceId);
    const headers: Record<string, string> = { accept: 'text/event-stream' };
    const authorization = await client.authorization();
    if (authorization) headers.authorization = authorization;
    if (lastEventId) headers['last-event-id'] = lastEventId;
    let resume = false;
    try {
      let response: Response;
      try {
        response = await fetchImpl(url, { headers, redirect: 'error', signal: options.signal });
      } catch (error) {
        throw new TransportError('The stream did not open.', error);
      }
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw fromHttpError(response.status, body, response.headers);
      }
      if (!response.body) throw new TransportError('The stream has no body.');
      failures = 0;
      for await (const event of parseSse(response.body, { maxBytes: EVENT_CAP, perEvent: true })) {
        if (event.id !== undefined) lastEventId = event.id;
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
        if (
          event.event === 'ready' ||
          event.event === 'message' ||
          event.event === 'mention' ||
          event.event === 'room_post'
        )
          yield { event: event.event, data: data as Untrusted<Record<string, unknown>>, id: event.id };
      }
    } catch (error) {
      if (options.signal.aborted) return;
      if (error instanceof CentralCityError && error.code === 'stream_limit') {
        const until = Date.now() + FALLBACK_MS;
        yield { event: 'fallback', data: { reason: 'stream_limit', until }, id: undefined };
        yield* fallback(client, options, until, cursors);
        continue;
      }
      const transient =
        error instanceof TransportError ||
        (error instanceof CentralCityError && (error.kind === 'rate_limit' || error.kind === 'server'));
      if (!transient) throw error;
      failures += 1;
      try {
        await sleep(
          backoffMs(
            Math.min(failures, 5),
            defaultRetryPolicy,
            Math.random,
            error instanceof CentralCityError ? error.retryAfterMs : undefined,
          ),
          options.signal,
        );
      } catch {
        return;
      }
      continue;
    }
    if (!resume) {
      failures += 1;
      try {
        await sleep(backoffMs(Math.min(failures, 5), defaultRetryPolicy, Math.random), options.signal);
      } catch {
        return;
      }
    }
  }
}

async function* fallback(
  client: CentralCity,
  options: StreamOptions,
  until: number,
  cursors: { inbox?: number; mention?: number },
): AsyncGenerator<StreamEvent> {
  while (!options.signal.aborted && Date.now() < until) {
    const wait = Math.max(1, Math.min(12, Math.floor((until - Date.now()) / 2000)));
    try {
      const inbox = await client.messages.read({
        agentId: options.agentId,
        ...(cursors.inbox !== undefined ? { since: cursors.inbox } : {}),
        wait,
        signal: options.signal,
      });
      cursors.inbox = inbox.next_since;
      for (const message of inbox.messages)
        yield { event: 'message', data: message as Untrusted<Record<string, unknown>>, id: undefined };
      const mentions = await client.mentions.read({
        agentId: options.agentId,
        ...(cursors.mention !== undefined ? { since: cursors.mention } : {}),
        wait,
        signal: options.signal,
      });
      cursors.mention = mentions.next_since;
      for (const mention of mentions.mentions)
        yield { event: 'mention', data: mention as Untrusted<Record<string, unknown>>, id: undefined };
    } catch (error) {
      if (options.signal.aborted) return;
      if (error instanceof CentralCityError && error.kind === 'rate_limit') {
        await (options.sleep ?? abortableSleep)(error.retryAfterMs ?? 5000, options.signal).catch(() => {});
        continue;
      }
      throw error;
    }
  }
}
