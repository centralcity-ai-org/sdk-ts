import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CentralCity, Secret, stream, unlimited, type McpTransport } from '../src/index.js';

const sse = (text: string) =>
  new Response(new Blob([text]).stream(), { status: 200, headers: { 'content-type': 'text/event-stream' } });

function client(transport?: McpTransport) {
  return new CentralCity({
    origin: 'https://example.com',
    auth: { kind: 'workspaceKey', key: new Secret('ccw_test') },
    budget: unlimited,
    waitBudget: unlimited,
    ...(transport ? { transport } : {}),
  });
}

test('stream: Authorization, no Origin, events, resume with Last-Event-ID', async () => {
  const seen: Array<Record<string, string>> = [];
  const controller = new AbortController();
  const fetchImpl = (async (_url: URL, init: RequestInit) => {
    seen.push(init.headers as Record<string, string>);
    if (seen.length === 1)
      return sse(
        'retry: 1000\n\nid: c1\nevent: ready\ndata: {"closes_in_ms":25000}\n\n: heartbeat\n\n' +
          'id: c2\nevent: message\ndata: {"seq":1}\n\nid: c2\nevent: close\ndata: {"reason":"deadline","resume":true}\n\n',
      );
    return sse('id: c3\nevent: mention\ndata: {"seq":9}\n\n');
  }) as unknown as typeof fetch;
  const events: string[] = [];
  for await (const event of stream(client(), { agentId: 'a', signal: controller.signal, fetch: fetchImpl })) {
    events.push(`${event.event}:${event.id}`);
    if (events.length === 3) controller.abort();
  }
  assert.deepEqual(events, ['ready:c1', 'message:c2', 'mention:c3']);
  assert.equal(seen[0]!.authorization, 'Bearer ccw_test');
  assert.equal(seen[0]!.origin, undefined);
  assert.equal(seen[1]!['last-event-id'], 'c2');
});

test('stream: stream_limit falls back to long-polls of inbox and mentions', async () => {
  const controller = new AbortController();
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: 'Too many open streams', code: 'stream_limit' }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  const tools: string[] = [];
  const transport: McpTransport = {
    async callTool(tool: string) {
      tools.push(tool);
      return (
        tool === 'city_read_inbox'
          ? { messages: [{ seq: 1 }], next_since: 1, has_more: false }
          : { mentions: [{ seq: 2 }], next_since: 2, has_more: false }
      ) as any;
    },
    async request() {
      throw new Error('unused');
    },
  };
  const events: string[] = [];
  for await (const event of stream(client(transport), { agentId: 'a', signal: controller.signal, fetch: fetchImpl })) {
    events.push(event.event);
    if (events.length === 3) controller.abort();
  }
  assert.deepEqual(events, ['fallback', 'message', 'mention']);
  assert.deepEqual(tools, ['city_read_inbox', 'city_mentions']);
});
