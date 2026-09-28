import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AmbiguousResultError,
  CentralCity,
  CentralCityError,
  LocalValidationError,
  OAuthProvider,
  Secret,
  SecretsAlreadyIssuedError,
  TOOLS,
  TransportError,
  UnsupportedError,
  asUntrusted,
  memoryTokenStore,
  tokenBucket,
  unlimited,
  type McpTransport,
} from '../src/index.js';

type Call = { tool: string; args: Record<string, any>; options: any };
function fake(respond: (call: Call, n: number) => unknown) {
  const calls: Call[] = [];
  const transport: McpTransport = {
    async callTool(tool: string, args: object, options?: object) {
      const call = { tool, args: args as Record<string, any>, options };
      calls.push(call);
      const out = respond(call, calls.length);
      if (out instanceof Error) throw out;
      return out as any;
    },
    async request() {
      throw new Error('not used');
    },
  };
  return { calls, transport };
}
const fast = { maxAttempts: 3, totalMs: 30_000, baseMs: 1, capMs: 2 };
const key = (transport: McpTransport, extra: object = {}) =>
  new CentralCity({
    origin: 'https://example.com',
    auth: { kind: 'workspaceKey', key: new Secret('ccw_test') },
    transport,
    retry: fast,
    budget: unlimited,
    waitBudget: unlimited,
    ...extra,
  });
const err = (code: string, kind: CentralCityError['kind'], extra: object = {}) =>
  new CentralCityError({
    kind,
    code,
    status: null,
    retryable: kind === 'rate_limit',
    serverMessage: asUntrusted('x'),
    ...extra,
  });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('the generated table: exactly four non-idempotent tools on /mcp, open room tools take room_credential', () => {
  const never = Object.entries(TOOLS.mcp)
    .filter(([, info]) => !info.idempotent)
    .map(([name]) => name)
    .sort();
  assert.deepEqual(never, [
    'city_ask',
    'city_create_invite',
    'city_create_workspace_key',
    'city_set_wake_webhook',
  ]);
  assert.ok(TOOLS.open.city_room_post!.properties.includes('room_credential'));
  assert.ok(!TOOLS.mcp.city_room_post!.properties.includes('room_credential'));
});

test('wire names per tool: snake_case for most, camelCase for city_create_job; keys generated', async () => {
  const { calls, transport } = fake(() => ({ ok: true }));
  const client = key(transport);
  await client.messages.send({ fromAgentId: 'a', toAgentId: 'b', text: 'hi', contextId: 'c' });
  await client.jobs.create({ requesterId: 'a', providerId: 'b', input: 'x' });
  assert.deepEqual(Object.keys(calls[0]!.args).sort(), [
    'context_id',
    'from_agent_id',
    'idempotency_key',
    'text',
    'to_agent_id',
  ]);
  assert.match(calls[0]!.args.idempotency_key, UUID);
  assert.deepEqual(Object.keys(calls[1]!.args).sort(), ['idempotencyKey', 'input', 'providerId', 'requesterId']);
});

test('unknown fields and keys on keyless tools are refused before sending', async () => {
  const { calls, transport } = fake(() => ({}));
  const client = key(transport);
  await assert.rejects(client.call('city_ack_inbox', { agent_id: 'a', seq: 1, extra: 1 }), LocalValidationError);
  await assert.rejects(
    client.call('city_ack_inbox', { agent_id: 'a', seq: 1 }, { idempotencyKey: crypto.randomUUID() }),
    LocalValidationError,
  );
  await assert.rejects(
    client.jobs.create({ requesterId: 'a', providerId: 'b', input: 'x', idempotencyKey: 'a2a:12345678' }),
    /reserved/,
  );
  assert.equal(calls.length, 0);
});

test('open endpoint: authenticated tools are unsupported; secret-issuing calls need a kept key', async () => {
  const { calls, transport } = fake(() => ({ workspace_id: 'w', workspace_key: 'ccw_x', claim_url: 'https://c' }));
  const open = new CentralCity({ origin: 'https://example.com', auth: { kind: 'open' }, transport, budget: unlimited });
  await assert.rejects(open.messages.read({ agentId: 'a' }), UnsupportedError);
  await assert.rejects(CentralCity.createWorkspace('https://example.com', { name: 'n', transport }), /idempotencyKey/);
  await assert.rejects(
    CentralCity.createWorkspace('https://example.com', { name: 'n', transport, idempotencyKey: 'my-key-123456' }),
    /unguessable/,
  );
  assert.equal(calls.length, 0);
  const seen: string[] = [];
  const created = await CentralCity.createWorkspace('https://example.com', {
    name: 'n',
    transport,
    onIdempotencyKey: async (k, ctx) => {
      assert.equal(calls.length, 0, 'the hook runs before any byte is sent');
      assert.equal(ctx.tool, 'city_create_workspace');
      assert.match(ctx.argsSha256, /^[0-9a-f]{64}$/);
      seen.push(k);
    },
  });
  assert.equal(calls[0]!.args.idempotency_key, seen[0]);
  assert.ok(created.workspace_key instanceof Secret);
  assert.ok(created.claim_url instanceof Secret);
  assert.equal(JSON.stringify(created).includes('ccw_x'), false);
});

test('a failing key hook sends nothing', async () => {
  const { calls, transport } = fake(() => ({}));
  await assert.rejects(
    CentralCity.createWorkspace('https://example.com', {
      name: 'n',
      transport,
      onIdempotencyKey: async () => {
        throw new Error('disk full');
      },
    }),
    /disk full/,
  );
  assert.equal(calls.length, 0);
});

test('replayed creation without secrets raises SecretsAlreadyIssuedError unless accepted', async () => {
  const { transport } = fake(() => ({ secrets_already_issued: true, workspace_key: null, workspace_id: 'w' }));
  await assert.rejects(
    CentralCity.createWorkspace('https://example.com', { name: 'n', transport, idempotencyKey: crypto.randomUUID() }),
    (error: unknown) => error instanceof SecretsAlreadyIssuedError && error.result.workspace_id === 'w',
  );
});

test('safe tools retry transport failures, 5xx and rate limits, with the same key and bytes', async () => {
  const { calls, transport } = fake((_, n) =>
    n === 1 ? new TransportError('reset') : n === 2 ? err('rate_limited', 'rate_limit', { retryAfterMs: 5 }) : { ok: 1 },
  );
  await key(transport).messages.send({ fromAgentId: 'a', toAgentId: 'b', text: 'hi' });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0]!.args, calls[2]!.args);
});

test('capacity, validation and conflicts are never retried', async () => {
  for (const [code, kind] of [
    ['too_many_rooms', 'capacity'],
    ['invalid_arguments', 'validation'],
    ['conflict', 'conflict'],
  ] as const) {
    const { calls, transport } = fake(() => err(code, kind));
    await assert.rejects(key(transport).messages.send({ fromAgentId: 'a', toAgentId: 'b', text: 'x' }), CentralCityError);
    assert.equal(calls.length, 1, code);
  }
});

test('never-retried tools raise AmbiguousResultError after one attempt', async () => {
  for (const run of [
    (c: CentralCity) => c.keys.create({ label: 'l' }),
    (c: CentralCity) => c.connections.createInvite({ agentId: 'a' }),
    (c: CentralCity) => c.webhooks.set({ agentId: 'a', url: 'https://h.example/w' }),
  ]) {
    const { calls, transport } = fake(() => new TransportError('lost'));
    await assert.rejects(run(key(transport)), AmbiguousResultError);
    assert.equal(calls.length, 1);
  }
});

test('keyless tools retry once after a network failure and mark the second error maybeApplied', async () => {
  const { calls, transport } = fake((_, n) => (n === 1 ? new TransportError('lost') : err('conflict', 'conflict')));
  await assert.rejects(key(transport).jobs.cancel('j'), (error: unknown) => {
    return error instanceof CentralCityError && error.maybeApplied === true;
  });
  assert.equal(calls.length, 2);
});

test('city_ask retries only on server-retryable codes, never after a network failure', async () => {
  const lost = fake(() => new TransportError('lost'));
  await assert.rejects(key(lost.transport).answers.ask({ agentId: 'a', question: 'q' }), TransportError);
  assert.equal(lost.calls.length, 1);
  const busy = fake((_, n) => (n === 1 ? err('ask_timeout', 'rate_limit') : { matches: [] }));
  await key(busy.transport).answers.ask({ agentId: 'a', question: 'q' });
  assert.equal(busy.calls.length, 2);
});

test('long-polls: default limit 20, timeout wait + 15 s, per-call response caps', async () => {
  const { calls, transport } = fake(() => ({ messages: [], next_since: 0, has_more: false }));
  const client = key(transport);
  await client.messages.read({ agentId: 'a', wait: 25 });
  await client.rooms.read({ roomId: 'r' });
  assert.equal(calls[0]!.args.limit, 20);
  assert.equal(calls[0]!.options.timeoutMs, 40_000);
  assert.equal(calls[0]!.options.maxResponseBytes, 256 * 1024 + 20 * 100 * 1024);
  assert.equal(calls[1]!.options.timeoutMs, 30_000);
  assert.equal(calls[1]!.options.maxResponseBytes, 256 * 1024 + 20 * 200 * 1024);
});

test('read results are not rewritten; write results wrap secrets', async () => {
  const { transport } = fake((call) =>
    call.tool === 'city_room_read'
      ? { messages: [{ text: 'secret', secret: 'not really' }], next_since: 1, has_more: false }
      : { webhook: { url: 'https://h' }, secret: 'whsec_abc', key_id: 'k' },
  );
  const client = key(transport);
  const page = await client.rooms.read({ roomId: 'r' });
  assert.equal(page.messages[0]!.secret, 'not really');
  const hook = await client.webhooks.set({ agentId: 'a', url: 'https://h.example/w' });
  assert.ok(hook.secret instanceof Secret);
  assert.equal(String(hook.secret), '[redacted]');
});

test('room link: a key only with rotate', async () => {
  const { calls, transport } = fake(() => ({}));
  const client = key(transport);
  await client.rooms.link({ roomId: 'r' });
  await client.rooms.link({ roomId: 'r', rotate: true });
  assert.equal(calls[0]!.args.idempotency_key, undefined);
  assert.match(calls[1]!.args.idempotency_key, UUID);
});

test('iterate pages forward; watch waits out rate limits and stops on capacity', async () => {
  const pages = [
    { messages: [{ seq: 1 }, { seq: 2 }], next_since: 2, has_more: true },
    { messages: [{ seq: 3 }], next_since: 3, has_more: false },
  ];
  const it = fake((_, n) => pages[n - 1]);
  const seen: number[] = [];
  for await (const m of key(it.transport).messages.iterate({ agentId: 'a' })) seen.push(m.seq);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(it.calls[1]!.args.since, 2);

  const w = fake((_, n) =>
    n === 1
      ? { messages: [{ seq: 5 }], next_since: 5, has_more: false }
      : n === 2
        ? err('rate_limited', 'rate_limit', { retryAfterMs: 1 })
        : n === 3
          ? { messages: [{ seq: 6 }], next_since: 6, has_more: false }
          : err('stream_limit', 'capacity'),
  );
  const got: number[] = [];
  const controller = new AbortController();
  await assert.rejects(async () => {
    for await (const m of key(w.transport, { retry: { ...fast, maxAttempts: 1 } }).messages.watch({
      agentId: 'a',
      signal: controller.signal,
    }))
      got.push(m.seq);
  }, /stream_limit/);
  assert.deepEqual(got, [5, 6]);
  assert.equal(w.calls[0]!.args.wait, 25);
  assert.equal(w.calls[2]!.args.since, 5);
});

test('token bucket: spends then waits for refill', async () => {
  let now = 0;
  const waits: number[] = [];
  const bucket = tokenBucket({
    perMinute: 2,
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });
  await bucket.take();
  await bucket.take();
  await bucket.take();
  assert.deepEqual(waits, [30_000]);
});

test('OAuth: one refresh after a 401, single-flight, rotated pair saved before use', async () => {
  let refreshes = 0;
  const store = memoryTokenStore({
    accessToken: new Secret('cca_old'),
    refreshToken: new Secret('ccr_0'),
    scopes: ['workspace:read'],
  });
  const fetchImpl = (async (_url: unknown, init: RequestInit) => {
    const form = new URLSearchParams(String(init.body));
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), `ccr_${refreshes}`);
    assert.equal(form.get('resource'), 'https://example.com/mcp');
    refreshes += 1;
    await new Promise((r) => setTimeout(r, 5));
    return new Response(
      JSON.stringify({ access_token: `cca_${refreshes}`, refresh_token: `ccr_${refreshes}`, expires_in: 3600, scope: 'workspace:read messages:read' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  const provider = new OAuthProvider({
    metadata: {
      issuer: 'https://example.com',
      authorization_endpoint: 'https://example.com/oauth/authorize',
      token_endpoint: 'https://example.com/oauth/token',
    },
    client: { clientId: 'c' },
    store,
    origin: 'https://example.com',
    fetch: fetchImpl,
  });
  await Promise.all([provider.refresh(), provider.refresh()]);
  assert.equal(refreshes, 1);
  assert.equal((await store.load())!.refreshToken!.reveal(), 'ccr_1');
  assert.deepEqual(provider.grantedScopes, ['workspace:read', 'messages:read']);

  const headers: string[] = [];
  const { transport } = fake((_, n) =>
    n === 1 ? err('authorization_expired', 'auth') : { ok: 1 },
  );
  const wrapped: McpTransport = {
    async callTool(tool, args, options) {
      headers.push((await provider.header())!);
      return transport.callTool(tool, args, options);
    },
    request: transport.request,
  };
  const client = new CentralCity({
    origin: 'https://example.com',
    auth: { kind: 'oauth', provider },
    transport: wrapped,
    budget: unlimited,
  });
  await client.workspace.get();
  assert.equal(refreshes, 2);
  assert.deepEqual(headers, ['Bearer cca_1', 'Bearer cca_2']);
});

test('rooms.update sends city_room_update with wire names', async () => {
  const { calls, transport } = fake(() => ({ room: {}, changed: true }));
  await key(transport).rooms.update({ roomId: 'r', history: 'full' });
  assert.equal(calls[0]!.tool, 'city_room_update');
  assert.deepEqual(calls[0]!.args, { room_id: 'r', history: 'full' });
});
