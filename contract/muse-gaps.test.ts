// Gap tests from the independent SDK review (written by Muse): error kinds, idempotent replays,
// pagination, credential refusal, room update, runtime errors and the open endpoint. Live-app
// contract style, mirroring
// contract/sdk.contract.test.ts: skipped when neither CC_APP_DIR nor
// CC_SDK_CONTRACT_ORIGIN is set. Run with: npm run test:contract
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import {
  CentralCity,
  CentralCityError,
  OAuthProvider,
  Secret,
  authorizationUrl,
  discover,
  exchangeCode,
  memoryTokenStore,
  pkcePair,
  registerClient,
} from '../src/index.js';
import { RuntimeClient, enroll } from '../src/runtime/index.js';
import { consent, harness, ownerPost, registerOwner, type Harness, type Owner } from './harness.js';

const h: Harness | null = await harness();
after(async () => {
  await h?.close();
});
const skip = () => (h ? false : 'set CC_APP_DIR or CC_SDK_CONTRACT_ORIGIN');

// Human owner with an OAuth client holding rooms scopes (AI workspaces cannot host rooms).
let rooms: { client: CentralCity; agentId: string } | undefined;
async function ownerRooms(): Promise<{ client: CentralCity; agentId: string }> {
  if (rooms) return rooms;
  const owner: Owner = await registerOwner(h!.origin);
  const agent = await ownerPost(h!.origin, owner, '/api/agents', {
    name: 'SDK gap host',
    capability: 'research',
    mode: 'external',
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.body));
  const metadata = await discover(h!.origin);
  const redirectUri = 'http://127.0.0.1:43124/callback';
  const clientId = await registerClient(metadata, { clientName: 'SDK gaps', redirectUris: [redirectUri] });
  const { verifier, challenge } = await pkcePair();
  const requested = ['workspace:read', 'rooms:host', 'rooms:join'];
  const state = randomUUID();
  const url = authorizationUrl(metadata, {
    clientId,
    redirectUri,
    scopes: requested,
    state,
    challenge,
    origin: h!.origin,
  });
  const back = await consent(h!.origin, owner, url, requested);
  const tokens = await exchangeCode(
    metadata,
    { clientId },
    { code: back.code, verifier, redirectUri, origin: h!.origin, scopes: requested },
  );
  const provider = new OAuthProvider({
    metadata,
    client: { clientId },
    store: memoryTokenStore(tokens),
    origin: h!.origin,
  });
  rooms = {
    client: new CentralCity({ origin: h!.origin, auth: { kind: 'oauth', provider } }),
    agentId: agent.body.agent.id as string,
  };
  return rooms;
}

async function makeRoom(slug?: string) {
  const o = await ownerRooms();
  const created = await o.client.rooms.create({
    agentId: o.agentId,
    name: `SDK gap ${randomUUID().slice(0, 8)}`,
    ...(slug ? { slug } : {}),
  });
  return { o, roomId: created.room.id as string };
}

// 1. Duplicate slugs collide: the server's 409 slug_taken reaches the SDK over MCP
// as a generic conflict (over MCP the specific code collapses to the generic one; see README).
test('rooms: a duplicate slug is a conflict', { skip: skip() }, async () => {
  const o = await ownerRooms();
  const slug = `sdk-gap-${randomUUID().slice(0, 8)}`;
  await o.client.rooms.create({ agentId: o.agentId, name: 'SDK gap one', slug });
  await assert.rejects(
    o.client.rooms.create({ agentId: o.agentId, name: 'SDK gap two', slug }),
    (error: unknown) => error instanceof CentralCityError && error.kind === 'conflict',
  );
});

// 2. Idempotency keys: the same key + same post replays instead of duplicating the seq.
test('rooms: same idempotency key replays the post', { skip: skip() }, async () => {
  const { o, roomId } = await makeRoom();
  const key = randomUUID();
  const first = await o.client.rooms.post({ roomId, agentId: o.agentId, text: 'gap replay', idempotencyKey: key });
  const second = await o.client.rooms.post({ roomId, agentId: o.agentId, text: 'gap replay', idempotencyKey: key });
  assert.equal(second.message.seq, first.message.seq);
});

// 3. Pagination: a limit-1 walk over since/next_since/has_more returns every post in order.
test('rooms: pagination walks to the end', { skip: skip() }, async () => {
  const { o, roomId } = await makeRoom();
  const seqs: number[] = [];
  for (let i = 0; i < 3; i++)
    seqs.push((await o.client.rooms.post({ roomId, agentId: o.agentId, text: `gap page ${i}` })).message.seq as number);
  const seen: number[] = [];
  let since = 0;
  for (;;) {
    const page = await o.client.rooms.read({ roomId, since, limit: 1 });
    for (const m of page.messages as Array<{ seq: number }>) seen.push(m.seq);
    if (!page.has_more) break;
    since = page.next_since;
  }
  assert.deepEqual(
    seen.filter((s) => seqs.includes(s)),
    seqs,
  );
});

// 4. Security: a room credential pasted into the message body is refused, as validation.
test('rooms: a credential in the message body is refused', { skip: skip() }, async () => {
  const { o, roomId } = await makeRoom();
  await assert.rejects(
    o.client.rooms.post({ roomId, agentId: o.agentId, text: `my key is crc_${'A'.repeat(43)} do not use` }),
    (error: unknown) => error instanceof CentralCityError && error.kind === 'validation',
  );
});

// 5. Typed-surface gap: city_room_update exists on the server but has no SDK method,
// so callers use the escape hatch. Fails if the tool disappears or the shape changes.
test('rooms: city_room_update works through the escape hatch', { skip: skip() }, async () => {
  const { o, roomId } = await makeRoom();
  const first = await o.client.call<{ room: unknown; changed: boolean }>('city_room_update', {
    room_id: roomId,
    history: 'from_join',
  });
  assert.equal(typeof first.changed, 'boolean');
  const second = await o.client.call<{ room: unknown; changed: boolean }>('city_room_update', {
    room_id: roomId,
    history: 'full',
  });
  assert.equal(typeof second.changed, 'boolean');
});

// 6. M3: enrollment with a bad code is an auth error (401 invalid enrollment code).
test('runtime: enroll with a bad code is an auth error', { skip: skip() }, async () => {
  await assert.rejects(
    enroll(h!.origin, { agentId: randomUUID(), enrollmentCode: 'cce_0000000000000000000000' }),
    (error: unknown) => error instanceof CentralCityError && error.kind === 'auth',
  );
});

// 7. M3: a regressed heartbeat sequence maps to the stable stale-sequence conflict.
test('runtime: a regressed heartbeat sequence is a stale-sequence conflict', { skip: skip() }, async () => {
  const owner = await registerOwner(h!.origin);
  const made = await ownerPost(h!.origin, owner, '/api/agents', {
    name: 'SDK gap runtime',
    description: 'stale heartbeat probe',
    mode: 'external',
    capability: 'research',
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const client = new RuntimeClient({
    origin: h!.origin,
    credential: { agentId: made.body.agent.id as string, token: new Secret(made.body.token as string) },
  });
  await client.heartbeat(5);
  await assert.rejects(
    client.heartbeat(3),
    (error: unknown) =>
      error instanceof CentralCityError &&
      error.code === 'runtime_sequence_stale' &&
      error.kind === 'conflict',
  );
});

// 8. Security: the open endpoint sends no Authorization header; the room credential
// travels as a tool argument, never in a URL or a header.
test('open endpoint: no Authorization header is sent', { skip: skip() }, async () => {
  const seen: Array<{ url: string; authorization: string | null }> = [];
  const recording: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(input), authorization: headers.get('authorization') });
    return fetch(input, init);
  };
  const open = new CentralCity({ origin: h!.origin, auth: { kind: 'open' }, fetch: recording });
  await open.agents.listTemplates();
  assert.ok(seen.length >= 1);
  for (const call of seen) {
    assert.equal(call.authorization, null);
    assert.ok(!call.url.includes('crc_') && !call.url.includes('ccw_'), call.url);
  }
});
