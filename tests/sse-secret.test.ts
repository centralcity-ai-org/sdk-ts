import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { test } from 'node:test';
import { parseSse } from '../src/sse.js';
import { Secret, revealed } from '../src/secret.js';

function stream(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}
async function collect(body: ReadableStream<Uint8Array>, maxBytes?: number) {
  const out = [];
  for await (const event of parseSse(body, maxBytes ? { maxBytes } : {})) out.push(event);
  return out;
}

test('SSE: events, ids, comments, multi-line data and CRLF, split anywhere', async () => {
  const text =
    ': heartbeat\r\n\r\nid: 5\r\nevent: ready\r\ndata: {"closes_in_ms":25000}\r\n\r\n' +
    'event: message\ndata: line one\ndata: line two\n\n' +
    'id: 9\nevent: mention\ndata: {"seq":9}\n\n';
  const whole = await collect(stream([text]));
  // Every split point, including inside a multi-byte character.
  const bytes = new TextEncoder().encode(text + 'data: Grüße\n\n');
  for (let cut = 1; cut < bytes.length; cut += 7) {
    const split = await collect(stream([bytes.slice(0, cut), bytes.slice(cut)]));
    assert.equal(split.length, 4, `cut at ${cut}`);
    assert.equal(split[3]!.data, 'Grüße');
  }
  assert.deepEqual(whole, [
    { event: 'ready', data: '{"closes_in_ms":25000}', id: '5' },
    { event: 'message', data: 'line one\nline two', id: '5' },
    { event: 'mention', data: '{"seq":9}', id: '9' },
  ]);
});

test('SSE: an unterminated final event is discarded (spec); byte cap enforced', async () => {
  // The event-stream spec drops a pending event when the stream ends without its blank line.
  assert.deepEqual(await collect(stream(['event: close\ndata: {"resume":true}'])), []);
  assert.deepEqual(await collect(stream(['event: close\ndata: {"resume":true}\n\n'])), [
    { event: 'close', data: '{"resume":true}', id: undefined },
  ]);
  await assert.rejects(collect(stream(['data: ' + 'x'.repeat(2000) + '\n\n']), 1000), /exceeded/);
});

test('Secret never prints its value', () => {
  const secret = new Secret('ccw_example-not-a-real-key');
  for (const shown of [String(secret), `${secret}`, JSON.stringify({ secret }), inspect(secret), inspect({ secret })])
    assert.ok(!shown.includes('ccw_example'), shown);
  assert.equal(secret.reveal(), 'ccw_example-not-a-real-key');
  assert.equal(revealed(secret), 'ccw_example-not-a-real-key');
  assert.equal(revealed('plain'), 'plain');
  assert.throws(() => new Secret(''));
});
