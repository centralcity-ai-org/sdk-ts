import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Secret } from '../src/index.js';
import { hex, hmacSha256, sha256Hex, utf8 } from '../src/internal/bytes.js';
import {
  EnrollmentLostError,
  ExecutorFailure,
  RuntimeClient,
  clockOffset,
  enroll,
  memorySequenceStore,
  runConnector,
  validOutput,
  type ConnectorEvent,
} from '../src/runtime/index.js';

const TOKEN = 'ccrt_' + 'x'.repeat(43);
type Seen = { method: string; path: string; body: string; headers: Record<string, string> };

/** A fake runtime server that checks every signature exactly as the service does. */
function server(handle: (seen: Seen, n: number) => Response | Promise<Response>, options: { skewMs?: number } = {}) {
  const calls: Seen[] = [];
  const fetchImpl = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const seen = { method: init.method ?? 'GET', path: url.pathname + url.search, body: String(init.body ?? ''), headers };
    calls.push(seen);
    const now = Date.now() + (options.skewMs ?? 0);
    const canonical = [seen.method, seen.path, headers['x-cc-timestamp'], headers['x-cc-nonce'], await sha256Hex(seen.body)].join('\n');
    const expected = hex(await hmacSha256(utf8(TOKEN), canonical));
    if (
      headers.authorization !== `Bearer ${TOKEN}` ||
      headers['x-cc-signature'] !== expected ||
      Math.abs(now - Number(headers['x-cc-timestamp'])) > 60_000
    )
      return new Response(JSON.stringify({ error: 'Invalid or expired runtime signature.' }), {
        status: 401,
        headers: { 'content-type': 'application/json', date: new Date(now).toUTCString() },
      });
    return handle(seen, calls.length);
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const credential = { agentId: '11111111-1111-4111-8111-111111111111', token: new Secret(TOKEN) };
const instant = async (_ms: number, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  await new Promise((resolve) => setImmediate(resolve));
};

test('the core has no node: imports outside src/node', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? (entry.name === 'node' ? [] : walk(join(dir, entry.name))) : [join(dir, entry.name)],
    );
  for (const file of walk('src')) assert.doesNotMatch(readFileSync(file, 'utf8'), /from 'node:/, file);
});

test('signed requests: query-signed reads sign the exact target; POST bodies are JSON', async () => {
  const { calls, fetchImpl } = server((seen) =>
    seen.path.startsWith('/api/runtime/inbox') ? json({ messages: [], next_since: 0, has_more: false }) : json({ ok: true }),
  );
  const client = new RuntimeClient({ origin: 'https://example.com', credential, fetch: fetchImpl });
  await client.messages.read({ since: 4, wait: 10 });
  await client.messages.ack(4);
  assert.equal(calls[0]!.path, '/api/runtime/inbox?since=4&limit=20&wait=10');
  assert.equal(calls[1]!.headers['content-type'], 'application/json');
  assert.equal(calls[1]!.body, '{"seq":4}');
  assert.notEqual(calls[0]!.headers['x-cc-nonce'], calls[1]!.headers['x-cc-nonce']);
  assert.equal(calls[0]!.headers.origin, undefined);
});

test('a skewed clock is corrected once from the Date header', async () => {
  const { calls, fetchImpl } = server(() => json({ ok: true, heartbeatSeconds: 30, ttlSeconds: 90 }), { skewMs: 5 * 60_000 });
  const clock = clockOffset();
  const client = new RuntimeClient({ origin: 'https://example.com', credential, fetch: fetchImpl, clock });
  await client.heartbeat(1);
  assert.equal(calls.length, 2);
  assert.ok(Math.abs(clock.get() - 5 * 60_000) < 5_000);
});

test('runtime 409s map to stable codes; the replay-capacity 429 is a rate limit', async () => {
  const { fetchImpl } = server((seen) =>
    seen.path === '/api/runtime/heartbeat'
      ? json({ error: 'Heartbeat sequence must increase.' }, 409)
      : json({ error: 'Runtime replay capacity reached.' }, 429, { 'retry-after': '2' }),
  );
  const client = new RuntimeClient({ origin: 'https://example.com', credential, fetch: fetchImpl, retry: { maxAttempts: 1, totalMs: 1, baseMs: 1, capMs: 1 } });
  await assert.rejects(client.heartbeat(1), { code: 'runtime_sequence_stale' });
  await assert.rejects(client.mentions.ack(1), { kind: 'rate_limit', code: 'runtime_replay_capacity', retryAfterMs: 2000 });
});

test('enrollment is never retried after a lost response', async () => {
  let attempts = 0;
  const lost = (async () => {
    attempts++;
    throw new TypeError('reset');
  }) as unknown as typeof fetch;
  await assert.rejects(enroll('https://example.com', { agentId: credential.agentId, enrollmentCode: new Secret('cce_x') }, { fetch: lost }), EnrollmentLostError);
  assert.equal(attempts, 1);
  const ok = (async () => json({ agent: { id: credential.agentId }, token: TOKEN, heartbeatSeconds: 30, ttlSeconds: 90 })) as unknown as typeof fetch;
  const enrolled = await enroll('https://example.com', { agentId: credential.agentId, enrollmentCode: 'cce_x' }, { fetch: ok });
  assert.ok(enrolled.credential.token instanceof Secret);
  assert.equal(String(enrolled.credential.token), '[redacted]');
});

test('validOutput mirrors the server limits', () => {
  assert.ok(validOutput({ a: 1 }));
  assert.ok(!validOutput([1]));
  assert.ok(!validOutput({ x: 'y'.repeat(40_000) }));
  let deep: Record<string, unknown> = {};
  for (let i = 0; i < 10; i++) deep = { deep };
  assert.ok(!validOutput(deep));
});

function loop(jobs: Array<Record<string, unknown> | 'paused' | 'limited'>) {
  const posted: { path: string; body: any }[] = [];
  const heartbeats: number[] = [];
  let claimed = 0;
  const { fetchImpl } = server((seen) => {
    if (seen.path === '/api/runtime/heartbeat') {
      heartbeats.push(JSON.parse(seen.body).sequence);
      return json({ ok: true, heartbeatSeconds: 30, ttlSeconds: 90 });
    }
    if (seen.path === '/api/runtime/jobs') {
      const next = jobs[claimed++];
      if (next === 'paused') return json({ error: 'Workspace is paused. Retry after it resumes.' }, 409);
      if (next === 'limited') return json({ error: 'Too many requests. Try again later.' }, 429, { 'retry-after': '1' });
      return json(next ? { job: next, leaseToken: 'lease-' + 'l'.repeat(20) } : { job: null });
    }
    posted.push({ path: seen.path, body: JSON.parse(seen.body) });
    return json({ job: {} });
  });
  return { fetchImpl, posted, heartbeats, claimedCount: () => claimed };
}
const job = (id: string, input = 'hello') => ({ id, requesterId: 'r', providerId: 'p', input, status: 'running' });

test('connector: results, bounded failures, timeouts, invalid output, pause and rate limits', async () => {
  const world = loop(['limited', job('j1'), 'paused', job('j2', 'fail'), job('j3', 'slow'), job('j4', 'bad'), job('j5', 'crash')]);
  const controller = new AbortController();
  const events: ConnectorEvent[] = [];
  const done = runConnector({
    origin: 'https://example.com',
    credential,
    fetch: world.fetchImpl,
    sequenceStore: memorySequenceStore(41),
    signal: controller.signal,
    executionTimeoutMs: 50,
    sleep: instant,
    execute: async (j, { signal }) => {
      if (j.input === 'fail') throw new ExecutorFailure('invalid-input');
      if (j.input === 'slow') await new Promise((resolve) => signal.addEventListener('abort', resolve));
      if (j.input === 'bad') return { big: 'x'.repeat(40_000) };
      if (j.input === 'crash') throw new Error('boom');
      return { echo: j.input };
    },
    onEvent: (event) => {
      events.push(event);
      if (world.posted.length === 5) controller.abort();
    },
  });
  await done;
  assert.equal(world.heartbeats[0], 42);
  assert.deepEqual(
    world.posted.map((p) => [p.path, p.body.output ?? p.body.reason]),
    [
      ['/api/runtime/jobs/j1/result', { echo: 'hello' }],
      ['/api/runtime/jobs/j2/failure', 'invalid-input'],
      ['/api/runtime/jobs/j3/failure', 'execution-timeout'],
      ['/api/runtime/jobs/j4/failure', 'invalid-output'],
      ['/api/runtime/jobs/j5/failure', 'runtime-unavailable'],
    ],
  );
  assert.ok(events.some((e) => e.type === 'paused'));
  assert.ok(events.some((e) => e.type === 'retrying' && e.reason === 'rate_limited' && e.after >= 1000));
  assert.ok(events.some((e) => e.type === 'connected'));
  assert.equal(events.at(-1)!.type, 'stopped');
});

test('connector: an invalid credential or a stale sequence store stops it with the error', async () => {
  const { fetchImpl } = server((seen) =>
    seen.path === '/api/runtime/heartbeat' ? json({ error: 'Heartbeat sequence must increase.' }, 409) : json({ job: null }),
  );
  await assert.rejects(
    runConnector({
      origin: 'https://example.com',
      credential,
      fetch: fetchImpl,
      sequenceStore: memorySequenceStore(),
      signal: new AbortController().signal,
      sleep: instant,
      execute: async () => ({}),
    }),
    { code: 'runtime_sequence_stale' },
  );
  const wrong = { ...credential, token: new Secret('ccrt_' + 'y'.repeat(43)) };
  await assert.rejects(
    runConnector({
      origin: 'https://example.com',
      credential: wrong,
      fetch: server(() => json({})).fetchImpl,
      sequenceStore: memorySequenceStore(),
      signal: new AbortController().signal,
      sleep: instant,
      execute: async () => ({}),
    }),
    { kind: 'auth' },
  );
});

test('fileSequenceStore: persisted before use, single writer, survives reopen', async () => {
  const { fileSequenceStore, defaultSequencePath, defaultStateDirectory } = await import('../src/node/index.js');
  const { mkdtemp, readFile, rm, stat, symlink } = await import('node:fs/promises');
  const { homedir, tmpdir } = await import('node:os');
  const windows = process.platform === 'win32';
  // On Windows the file lives in the per-user default directory (ACLs come from the profile);
  // elsewhere a temporary directory is enough, and the POSIX mode is checked.
  const dir = windows ? defaultStateDirectory() : await mkdtemp(join(tmpdir(), 'cc-seq-'));
  const file = windows ? defaultSequencePath(`test-${process.pid}-${Date.now()}`) : join(dir, 'sequence');
  try {
    const store = await fileSequenceStore(file);
    assert.equal(await store.next(), 0);
    assert.equal(await store.next(), 1);
    assert.equal((await readFile(file, 'utf8')).trim(), '1');
    if (windows) {
      const profile = (process.env.LOCALAPPDATA || homedir()).toLowerCase();
      assert.ok(file.toLowerCase().startsWith(profile), `${file} is inside the user profile`);
    } else assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(fileSequenceStore(file), /lock/);
    await store.close();
    const again = await fileSequenceStore(file);
    assert.equal(await again.next(), 2);
    await again.close();
    if (!windows) {
      await symlink(file, join(dir, 'link'));
      await assert.rejects(fileSequenceStore(join(dir, 'link')), /symlink/);
    }
  } finally {
    if (windows) await rm(file, { force: true });
    else await rm(dir, { recursive: true, force: true });
  }
});

test('default state paths are per user', async () => {
  const { defaultSequencePath, defaultStateDirectory } = await import('../src/node/index.js');
  const { homedir } = await import('node:os');
  const base = process.platform === 'win32' ? process.env.LOCALAPPDATA || homedir() : homedir();
  assert.ok(defaultStateDirectory().startsWith(base));
  assert.ok(defaultSequencePath('11111111-1111-4111-8111-111111111111').endsWith('.sequence'));
  assert.throws(() => defaultSequencePath('../escape'), /Invalid agent id/);
});

test('the SDK state directory is tightened to 0700 even when it already existed', { skip: process.platform === 'win32' && 'no POSIX modes on Windows' }, async () => {
  const { fileSequenceStore, defaultSequencePath } = await import('../src/node/index.js');
  const { mkdtemp, chmod, stat, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'cc-state-'));
  await chmod(dir, 0o755);
  const previous = process.env.CC_SDK_STATE_DIR;
  process.env.CC_SDK_STATE_DIR = dir;
  try {
    const store = await fileSequenceStore(defaultSequencePath('22222222-2222-4222-8222-222222222222'));
    await store.close();
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  } finally {
    if (previous === undefined) delete process.env.CC_SDK_STATE_DIR;
    else process.env.CC_SDK_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
