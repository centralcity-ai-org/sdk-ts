import { TransportError } from './errors.js';

export interface SseEvent {
  /** `event:` field; `message` when absent. */
  event: string;
  data: string;
  /** Last `id:` seen on or before this event (for Last-Event-ID resume). */
  id: string | undefined;
}

/**
 * Parses a text/event-stream body (fetch-based, so requests can carry Authorization and never an
 * Origin header, unlike EventSource). Handles CRLF/LF/CR line ends, multi-line `data:`, comments
 * (`: heartbeat`), `id:` and chunks split anywhere, including inside a UTF-8 character. As
 * the spec requires, an event is dispatched only at its blank line; an unterminated one at the end
 * of the stream is discarded. Bytes are
 * counted as they arrive and the read is aborted past `maxBytes` (with `perEvent`, the count
 * restarts at each event boundary, for long-lived streams).
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  options: { maxBytes?: number; perEvent?: boolean } = {},
): AsyncGenerator<SseEvent> {
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const decoder = new TextDecoder('utf-8');
  const reader = body.getReader();
  let buffer = '';
  let total = 0;
  let lastId: string | undefined;
  let event = '';
  let data: string[] = [];
  let sawField = false;

  const dispatch = (): SseEvent | null => {
    const ready = sawField && data.length > 0;
    const out = ready ? { event: event || 'message', data: data.join('\n'), id: lastId } : null;
    event = '';
    data = [];
    sawField = false;
    return out;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) throw new TransportError(`Event stream exceeded ${maxBytes} bytes.`);
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) buffer += decoder.decode();
      // Split complete lines; keep a trailing partial line (and a lone trailing CR) for later.
      for (;;) {
        const match = /\r\n|\n|\r/.exec(buffer);
        if (!match) break;
        if (match[0] === '\r' && match.index === buffer.length - 1 && !done) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (line === '') {
          if (options.perEvent) total = new TextEncoder().encode(buffer).byteLength;
          const ready = dispatch();
          if (ready) yield ready;
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') {
          data.push(value);
          sawField = true;
        } else if (field === 'event') {
          event = value;
          sawField = true;
        } else if (field === 'id') {
          if (!value.includes('\u0000')) lastId = value;
        }
      }
      // At the end of the stream a pending, unterminated event is discarded (event-stream spec).
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}
