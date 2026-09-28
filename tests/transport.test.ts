import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CentralCityError,
  HttpMcpTransport,
  LocalValidationError,
  ProtocolError,
  TransportError,
  bearer,
} from '../src/index.js';

type Seen = { url: string; init: RequestInit; body: any; headers: Record<string, string> };
function mock(respond: (seen: Seen) => Response | Promise<Response>) {
  const calls: Seen[] = [];
  const fetchImpl = (async (url: URL | string, init: RequestInit = {}) => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const seen = { url: String(url), init, body: JSON.parse(String(init.body)), headers };
    calls.push(seen);
    return respond(seen);
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const json = (value: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...extra },
  });

test('modern tools/call: envelope, Mcp-Method/Mcp-Name headers, no Origin, no redirects', async () => {
  const { calls, fetchImpl } = mock(() =>
    json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }], structuredContent: { ok: 1 } } }),
  );
  const transport = new HttpMcpTransport({
    endpoint: 'https://example.com/mcp/open',
    fetch: fetchImpl,
    clientInfo: { name: 'test', version: '1' },
  });
  assert.deepEqual(await transport.callTool('city_list_templates', {}), { ok: 1 });
  const [call] = calls;
  assert.equal(call!.headers['mcp-protocol-version'], '2026-07-28');
  assert.equal(call!.headers['mcp-method'], 'tools/call');
  assert.equal(call!.headers['mcp-name'], 'city_list_templates');
  assert.equal(call!.headers['content-type'], 'application/json');
  assert.equal(call!.headers.origin, undefined);
  assert.equal(call!.headers.authorization, undefined);
  assert.equal(call!.init.redirect, 'error');
  assert.equal(call!.body.params.name, 'city_list_templates');
  assert.equal(call!.body.params._meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
  assert.deepEqual(call!.body.params._meta['io.modelcontextprotocol/clientInfo'], { name: 'test', version: '1' });
});

test('bearer auth, SSE responses and tool errors', async () => {
  const sse = new Response(
    'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"{\\"error\\":{\\"code\\":\\"room_closed\\",\\"message\\":\\"Closed.\\",\\"retryable\\":false}}"}]}}\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
  const { calls, fetchImpl } = mock(() => sse);
  const transport = new HttpMcpTransport({
    endpoint: 'https://example.com/mcp',
    fetch: fetchImpl,
    auth: bearer('ccw_example-not-a-real-key'),
  });
  await assert.rejects(transport.callTool('city_room_post', { room_id: 'r' }), (error: unknown) => {
    assert.ok(error instanceof CentralCityError);
    assert.equal(error.code, 'room_closed');
    assert.equal(error.kind, 'conflict');
    return true;
  });
  assert.equal(calls[0]!.headers.authorization, 'Bearer ccw_example-not-a-real-key');
});

test('HTTP errors, JSON-RPC errors, oversized bodies and bad endpoints', async () => {
  const limited = mock(() => json({ error: 'Too many requests. Try again later.' }, 429, { 'retry-after': '7' }));
  const t1 = new HttpMcpTransport({ endpoint: 'https://example.com/mcp', fetch: limited.fetchImpl });
  await assert.rejects(t1.request('tools/list'), (e: any) => e.kind === 'rate_limit' && e.retryAfterMs === 7000);
  const rpc = mock(() => json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Nope.' } }));
  const t2 = new HttpMcpTransport({ endpoint: 'https://example.com/mcp', fetch: rpc.fetchImpl });
  await assert.rejects(t2.request('tools/list'), ProtocolError);
  await assert.rejects(t2.callTool('city_room_post', { text: 'x'.repeat(70_000) }), LocalValidationError);
  assert.equal(rpc.calls.length, 1, 'the oversized request was never sent');
  for (const endpoint of ['http://example.com/mcp', 'https://u:p@example.com/mcp', 'https://example.com/mcp?x=1'])
    assert.throws(() => new HttpMcpTransport({ endpoint }), LocalValidationError);
  assert.doesNotThrow(() => new HttpMcpTransport({ endpoint: 'http://127.0.0.1:4310/mcp' }));
  const big = mock(() => json({ result: { structuredContent: 'x'.repeat(5000) } }));
  const t3 = new HttpMcpTransport({ endpoint: 'https://example.com/mcp', fetch: big.fetchImpl, maxResponseBytes: 1000 });
  await assert.rejects(t3.request('tools/list'), TransportError);
  const broken = mock(() => {
    throw new TypeError('network down');
  });
  const t4 = new HttpMcpTransport({ endpoint: 'https://example.com/mcp', fetch: broken.fetchImpl });
  await assert.rejects(t4.request('tools/list'), TransportError);
});

test('legacy protocol runs initialize once, then plain requests', async () => {
  const { calls, fetchImpl } = mock(({ body }) =>
    json({ jsonrpc: '2.0', id: body.id, result: body.method === 'initialize' ? { protocolVersion: '2025-11-25' } : { tools: [] } }),
  );
  const transport = new HttpMcpTransport({ endpoint: 'https://example.com/mcp/open', fetch: fetchImpl, protocol: 'legacy' });
  await transport.request('tools/list');
  await transport.request('tools/list');
  assert.deepEqual(calls.map((c) => c.body.method), ['initialize', 'tools/list', 'tools/list']);
  assert.equal(calls[1]!.headers['mcp-protocol-version'], '2025-11-25');
  assert.equal(calls[1]!.headers['mcp-method'], undefined);
  assert.equal(calls[1]!.body.params._meta, undefined);
});
