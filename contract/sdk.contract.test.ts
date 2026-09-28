// SDK contract suite against a local app build (see harness.ts for CC_APP_DIR and
// CC_SDK_CONTRACT_ORIGIN). Skipped when neither is set.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  AmbiguousResultError,
  CentralCity,
  CentralCityError,
  LocalValidationError,
  OAuthProvider,
  Secret,
  SecretsAlreadyIssuedError,
  UnsupportedError,
  authorizationUrl,
  discover,
  exchangeCode,
  highEntropyKey,
  memoryTokenStore,
  pkcePair,
  registerClient,
  stream,
  type McpTransport,
} from '../src/index.js';
import { enroll, memorySequenceStore, runConnector, RuntimeClient, type ConnectorEvent } from '../src/runtime/index.js';
import { consent, harness, hostedHarness, ownerPost, registerOwner, type Harness, type Owner } from './harness.js';

const h: Harness | null = await harness();
after(async () => {
  await h?.close();
});
const skip = () => (h ? false : 'set CC_APP_DIR or CC_SDK_CONTRACT_ORIGIN');

const agentManifest = (name: string, maxChildren = 0) => ({
  apiVersion: 'centralcity.agent/v1',
  kind: 'Agent',
  metadata: { name },
  spec: { capabilities: ['research'], runtime: { mode: 'external' }, policy: { maxChildren } },
});

// One AI workspace per run (the open endpoint allows a few per address per hour).
type Ai = { key: Secret; id: string; scopes: string[]; client: CentralCity; agents: string[]; enrollment: Map<string, Secret> };
let ai: Promise<Ai> | undefined;
function aiWorkspace(): Promise<Ai> {
  ai ??= createAiWorkspace();
  return ai;
}
async function createAiWorkspace(): Promise<Ai> {
  const keyUsed: string[] = [];
  const created = await CentralCity.createWorkspace(h!.origin, {
    name: 'SDK contract',
    onIdempotencyKey: async (key) => {
      keyUsed.push(key);
    },
  });
  // A replay with the same key never re-issues secrets.
  await assert.rejects(
    CentralCity.createWorkspace(h!.origin, { name: 'SDK contract', idempotencyKey: keyUsed[0]! }),
    SecretsAlreadyIssuedError,
  );
  const client = new CentralCity({ origin: h!.origin, auth: { kind: 'workspaceKey', key: created.workspace_key } });
  const w = { key: created.workspace_key as Secret, id: created.workspace_id as string, scopes: created.key.scopes as string[], client, agents: [] as string[], enrollment: new Map<string, Secret>() };
  // A two-agent team with a directional connection alpha -> beta (messaging needs one).
  const team = await client.agents.applyTeam({
    manifest: {
      apiVersion: 'centralcity.agent/v1',
      kind: 'Team',
      metadata: { name: 'sdk-team' },
      spec: {
        coordinator: 'sdk-alpha',
        members: [
          { name: 'sdk-alpha', manifest: agentManifest('sdk-alpha', 1) },
          { name: 'sdk-beta', manifest: agentManifest('sdk-beta') },
        ],
        connections: [{ from: 'sdk-alpha', to: 'sdk-beta' }],
        policy: { budgetUsd: 0 },
      },
    },
  });
  const byName = (name: string) => {
    const found = (team.agents as Array<{ name: string; agent_id: string }>).find((a) => a.name === name);
    assert.ok(found, `agent ${name}`);
    return found.agent_id;
  };
  // Enrollment codes come back as Secrets.
  assert.ok(team.agents[0].enrollment.enrollment_code instanceof Secret);
  w.agents.push(byName('sdk-alpha'), byName('sdk-beta'));
  for (const agent of team.agents as Array<{ agent_id: string; enrollment?: { enrollment_code?: unknown } }>)
    if (agent.enrollment?.enrollment_code instanceof Secret) w.enrollment.set(agent.agent_id, agent.enrollment.enrollment_code);
  // Invites are Secrets and can be listed and revoked (F4; same-workspace requests are refused).
  const invite = await client.connections.createInvite({ agentId: w.agents[1]! });
  assert.ok(invite.invite_token instanceof Secret);
  await assert.rejects(
    client.connections.request({ fromAgentId: w.agents[0]!, inviteToken: invite.invite_token }),
    (error: unknown) => error instanceof CentralCityError && error.code === 'same_workspace' && error.kind === 'validation',
  );
  const invites = await client.connections.listInvites();
  assert.ok(JSON.stringify(invites).includes(invite.invite.id));
  await client.connections.revokeInvite(invite.invite.id);
  return w;
}

test('open endpoint: create, replay, local refusals, unsupported tools', { skip: skip() }, async () => {
  const w = await aiWorkspace();
  assert.ok(w.key instanceof Secret);
  assert.ok(!w.scopes.includes('rooms:host'));
  assert.ok(!w.scopes.includes('results:publish'));
  await assert.rejects(
    CentralCity.createWorkspace(h!.origin, { name: 'x', idempotencyKey: 'aaaaaaaa-guessable' }),
    LocalValidationError,
  );
  const open = new CentralCity({ origin: h!.origin, auth: { kind: 'open' } });
  await assert.rejects(open.workspace.get(), UnsupportedError);
  const templates = await open.agents.listTemplates();
  assert.ok(Array.isArray(templates.templates));
});

test('workspace key: get over both protocol revisions, keys list/create/revoke', { skip: skip() }, async () => {
  const w = await aiWorkspace();
  const view = await w.client.workspace.get();
  assert.ok(view);
  const legacy = new CentralCity({
    origin: h!.origin,
    auth: { kind: 'workspaceKey', key: w.key },
    protocol: 'legacy',
  });
  assert.deepEqual(Object.keys(await legacy.workspace.get()).sort(), Object.keys(view).sort());
  const minted = await w.client.keys.create({ label: 'child', scopes: ['workspace:read'] });
  assert.ok(minted.workspace_key instanceof Secret);
  const listed = await w.client.keys.list();
  assert.ok(JSON.stringify(listed).includes(minted.key.id));
  const revoked = await w.client.keys.revoke(minted.key.id);
  assert.ok(revoked);
});

test('an AI-created workspace cannot host rooms (ScopeError-kind)', { skip: skip() }, async () => {
  const w = await aiWorkspace();
  await assert.rejects(
    w.client.rooms.create({ agentId: w.agents[0]!, name: 'Nope' }),
    (error: unknown) => error instanceof CentralCityError && ['scope', 'forbidden'].includes(error.kind),
  );
});

test('messaging: send, long-poll read, watch, ack, validation issues', { skip: skip() }, async () => {
  const w = await aiWorkspace();
  const [a, b] = w.agents as [string, string];
  const sent = await w.client.messages.send({ fromAgentId: a, toAgentId: b, text: 'hello from the SDK' });
  assert.ok(sent);
  const page = await w.client.messages.read({ agentId: b, wait: 2 });
  assert.equal(page.messages.at(-1)!.parts?.[0]?.text ?? page.messages.at(-1)!.text, 'hello from the SDK');
  const controller = new AbortController();
  setTimeout(
    () => void w.client.messages.send({ fromAgentId: a, toAgentId: b, text: 'second' }),
    300,
  );
  let seen = 0;
  for await (const message of w.client.messages.watch({
    agentId: b,
    since: page.next_since,
    wait: 5,
    signal: controller.signal,
  })) {
    assert.ok(message);
    seen += 1;
    controller.abort();
  }
  assert.equal(seen, 1);
  const acked = await w.client.messages.ack({ agentId: b, seq: page.next_since });
  assert.ok(acked);
  await assert.rejects(
    w.client.messages.send({ fromAgentId: 'not-a-uuid', toAgentId: b, text: 'x' }),
    (error: unknown) =>
      error instanceof CentralCityError &&
      error.kind === 'validation' &&
      error.code === 'invalid_arguments' &&
      /from_agent_id/.test(String(error.serverMessage)),
  );
  const mentions = await w.client.mentions.read({ agentId: b });
  assert.ok(Array.isArray(mentions.mentions));
});

test('stream: a message arrives as an SSE event', { skip: skip() }, async () => {
  const w = await aiWorkspace();
  const [a, b] = w.agents as [string, string];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const events: string[] = [];
  for await (const event of stream(w.client, { agentId: b, signal: controller.signal })) {
    events.push(event.event);
    if (event.event === 'ready') await w.client.messages.send({ fromAgentId: a, toAgentId: b, text: 'streamed' });
    if (event.event === 'message' && (event.data as any).parts?.[0]?.text === 'streamed') break;
  }
  clearTimeout(timer);
  assert.equal(events[0], 'ready');
  assert.ok(events.includes('message'), events.join());
});

test('webhooks: a local URL is a validation error after one attempt', { skip: skip() }, async () => {
  const w = await aiWorkspace();
  await assert.rejects(
    w.client.webhooks.set({ agentId: w.agents[0]!, url: 'http://127.0.0.1:9/hook' }),
    (error: unknown) => error instanceof CentralCityError && error.kind === 'validation',
  );
});

test('never-retried minting: a lost response is AmbiguousResultError', { skip: skip() }, async () => {
  const w = await aiWorkspace();
  let attempts = 0;
  const losing: typeof fetch = async (input, init) => {
    attempts += 1;
    await fetch(input, init); // reaches the server...
    throw new TypeError('connection reset'); // ...but the answer is lost
  };
  const client = new CentralCity({ origin: h!.origin, auth: { kind: 'workspaceKey', key: w.key }, fetch: losing });
  await assert.rejects(client.keys.create({ label: 'lost' }), AmbiguousResultError);
  assert.equal(attempts, 1);
  const keys = await w.client.keys.list();
  const lost = keys.keys.filter((key: any) => key.label === 'lost' && !key.revoked_at);
  assert.equal(lost.length, 1, 'the minted key exists and can be reconciled');
  await w.client.keys.revoke(lost[0].id);
});

// ---- A human owner, OAuth with rooms:host, rooms and the invite join ----------------------

let owner: Owner | undefined;
let oauth: { client: CentralCity; provider: OAuthProvider; agentId: string } | undefined;
async function ownerClient() {
  if (oauth) return oauth;
  owner = await registerOwner(h!.origin);
  const agent = await ownerPost(h!.origin, owner, '/api/agents', {
    name: 'SDK host',
    capability: 'research',
    mode: 'external',
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.body));
  const metadata = await discover(h!.origin);
  const redirectUri = 'http://127.0.0.1:43123/callback';
  const clientId = await registerClient(metadata, { clientName: 'SDK contract', redirectUris: [redirectUri] });
  const { verifier, challenge } = await pkcePair();
  const requested = ['workspace:read', 'rooms:host', 'rooms:join', 'messages:read'];
  const state = randomUUID();
  const url = authorizationUrl(metadata, { clientId, redirectUri, scopes: requested, state, challenge, origin: h!.origin });
  // The owner leaves messages:read unchecked on the consent page.
  const granted = ['workspace:read', 'rooms:host', 'rooms:join'];
  const back = await consent(h!.origin, owner, url, granted);
  assert.equal(back.state, state);
  const tokens = await exchangeCode(metadata, { clientId }, {
    code: back.code,
    verifier,
    redirectUri,
    origin: h!.origin,
    scopes: requested,
  });
  assert.deepEqual([...tokens.scopes].sort(), [...granted].sort());
  const provider = new OAuthProvider({
    metadata,
    client: { clientId },
    store: memoryTokenStore(tokens),
    origin: h!.origin,
  });
  oauth = {
    client: new CentralCity({ origin: h!.origin, auth: { kind: 'oauth', provider } }),
    provider,
    agentId: agent.body.agent.id,
  };
  return oauth;
}

test('OAuth: consent with an unchecked scope, granted scopes, refresh rotation, scope error', { skip: skip() }, async () => {
  const o = await ownerClient();
  await o.client.workspace.get();
  assert.ok(o.provider.grantedScopes?.includes('rooms:host'));
  await o.provider.refresh();
  await o.client.workspace.get();
  await assert.rejects(
    o.client.messages.read({ agentId: o.agentId }),
    (error: unknown) => error instanceof CentralCityError && error.kind === 'scope',
  );
});

test('rooms: create, post, long-poll read, members (OAuth rooms:host)', { skip: skip() }, async () => {
  const o = await ownerClient();
  const created = await o.client.rooms.create({ agentId: o.agentId, name: 'SDK room' });
  const roomId = created.room.id as string;
  if (created.link) assert.ok(created.link.link instanceof Secret || typeof created.link.link !== 'string');
  const posted = await o.client.rooms.post({ roomId, agentId: o.agentId, text: 'host here' });
  assert.ok(posted.message.seq >= 1);
  const page = await o.client.rooms.read({ roomId, wait: 1 });
  assert.ok(page.messages.some((m: any) => m.seq === posted.message.seq));
  const members = await o.client.rooms.members(roomId);
  assert.ok(JSON.stringify(members).includes(o.agentId));

  const hostView = await o.client.rooms.read({ roomId, since: posted.message.seq - 1 });
  assert.ok(hostView.messages.length >= 1);
});

test('guest: join by /j/ invite, post and confirm the seq (hosted-mode app)', { skip: !process.env.CC_APP_DIR && 'needs CC_APP_DIR' }, async (t) => {
  const hosted = (await hostedHarness())!;
  t.after(() => hosted.close());
  const host = await registerOwner(hosted.origin);
  const agent = await ownerPost(hosted.origin, host, '/api/agents', { name: 'Host', capability: 'research', mode: 'external' });
  assert.equal(agent.status, 201, JSON.stringify(agent.body));
  const room = await ownerPost(hosted.origin, host, '/api/rooms', {
    name: 'Invite room',
    agent_id: agent.body.agent.id,
    idempotency_key: randomUUID(),
  });
  assert.equal(room.status, 201, JSON.stringify(room.body));
  const link = await ownerPost(hosted.origin, host, '/api/links', { target: 'room', room_id: room.body.room.id });
  assert.equal(link.status, 201, JSON.stringify(link.body));
  assert.ok(String(link.body.url).startsWith(`${hosted.publicOrigin}/j/`));

  const started = Date.now();
  const guest = await CentralCity.joinInvite(hosted.origin, { inviteLink: link.body.url, name: 'SDK guest' });
  assert.ok(guest.credential instanceof Secret);
  assert.equal(JSON.stringify(guest.joined).includes(guest.credential.reveal()), false);
  const mine = await guest.post({ text: 'guest here' });
  const seq = (mine.message?.seq ?? mine.seq) as number;
  const read = await guest.read({ since: seq - 1 });
  assert.ok(read.messages.some((m: any) => m.seq === seq));
  console.log(`guest join -> confirmed post: ${Date.now() - started} ms`);
  const members = await guest.members();
  assert.ok(JSON.stringify(members).includes('SDK guest'));
});

test('runtime (M3): enroll, connector completes a job, runtime messaging and mentions, signed stream', { skip: skip() }, async () => {
  const w = await aiWorkspace();
  const [alpha, beta] = w.agents as [string, string];
  const code = w.enrollment.get(beta);
  assert.ok(code, 'enrollment code for beta');
  const { credential } = await enroll(h!.origin, { agentId: beta, enrollmentCode: code! });
  assert.ok(credential.token instanceof Secret);

  // The job loop: jobs to external runtimes come from a human owner's console (assistant jobs
  // go to hosted demonstration agents only).
  const person = await registerOwner(h!.origin);
  const makeAgent = async (name: string) => {
    const made = await ownerPost(h!.origin, person, '/api/agents', { name, description: 'SDK runtime test', mode: 'external', capability: 'research' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return { id: made.body.agent.id as string, token: new Secret(made.body.token as string) };
  };
  const requester = await makeAgent('SDK requester');
  const provider = await makeAgent('SDK provider');
  const controller = new AbortController();
  const events: ConnectorEvent[] = [];
  const running = runConnector({
    origin: h!.origin,
    credential: { agentId: provider.id, token: provider.token },
    sequenceStore: memorySequenceStore(),
    signal: controller.signal,
    pollMs: 200,
    execute: async (job) => ({ answer: `echo: ${job.input}` }),
    onEvent: (event) => events.push(event),
  });
  try {
    for (let i = 0; i < 50 && !events.some((e) => e.type === 'connected'); i++) await new Promise((r) => setTimeout(r, 100));
    // Both agents must be reachable: the requester sends one heartbeat of its own.
    await new RuntimeClient({ origin: h!.origin, credential: { agentId: requester.id, token: requester.token } }).heartbeat(1);
    const connection = await ownerPost(h!.origin, person, '/api/connections', { fromAgentId: requester.id, toAgentId: provider.id });
    assert.ok([200, 201].includes(connection.status), JSON.stringify(connection.body));
    const submitted = await ownerPost(h!.origin, person, '/api/jobs', { requesterId: requester.id, providerId: provider.id, input: 'ping', idempotencyKey: crypto.randomUUID() });
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    const jobId = submitted.body.job.id as string;
    for (let i = 0; i < 60 && !events.some((e) => (e.type === 'completed' || e.type === 'failed') && e.jobId === jobId); i++)
      await new Promise((r) => setTimeout(r, 200));
    assert.ok(events.some((e) => e.type === 'completed' && e.jobId === jobId), JSON.stringify(events));
    const snapshot = await fetch(new URL('/api/snapshot', h!.origin), { headers: { cookie: person.cookie } }).then((r) => r.json());
    const done = snapshot.jobs.find((j: any) => j.id === jobId);
    assert.equal(done.status, 'completed');
    assert.deepEqual(done.output, { answer: 'echo: ping' });
  } finally {
    controller.abort();
    await running;
  }

  // The enrolled AI-workspace agent: heartbeat, runtime messaging, mentions and the signed stream.
  const runtime = new RuntimeClient({ origin: h!.origin, credential });
  await runtime.heartbeat(0);
  await w.client.messages.send({ fromAgentId: alpha, toAgentId: beta, text: 'to the runtime' });
  const inbox = await runtime.messages.read({ wait: 2 });
  const last = inbox.messages.at(-1) as any;
  assert.ok(JSON.stringify(last).includes('to the runtime'));
  await runtime.messages.ack(inbox.next_since);
  const mentions = await runtime.mentions.read({});
  assert.ok(Array.isArray(mentions.mentions));

  const streamController = new AbortController();
  const timer = setTimeout(() => streamController.abort(), 15_000);
  const seen: string[] = [];
  for await (const event of runtime.stream({ signal: streamController.signal })) {
    seen.push(event.event);
    if (event.event === 'ready') await w.client.messages.send({ fromAgentId: alpha, toAgentId: beta, text: 'streamed to runtime' });
    if (event.event === 'message') break;
  }
  clearTimeout(timer);
  assert.deepEqual([seen[0], seen.at(-1)], ['ready', 'message']);
});

test('highEntropyKey: the SDK port agrees with the app', { skip: !process.env.CC_APP_DIR && 'needs CC_APP_DIR' }, async () => {
  const app = (await import(pathToFileURL(`${process.env.CC_APP_DIR}/server/autonomy/index.ts`).href)) as {
    highEntropyKey(key: unknown): boolean;
  };
  const samples: unknown[] = [
    randomUUID(),
    '00000000-0000-4000-8000-000000000000',
    '123e4567-e89b-12d3-a456-426614174000',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'my-idempotency-key-2026-09-28',
    'x'.repeat(40),
    'abcdefghijklmnopqrstuv',
    Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
    '',
    42,
    null,
  ];
  const alphabet = 'abcdef0123456789-ABCDEFxyz_';
  for (let i = 0; i < 2000; i++) {
    const length = 8 + Math.floor(Math.random() * 50);
    samples.push(Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(''));
  }
  for (const sample of samples) assert.equal(highEntropyKey(sample), app.highEntropyKey(sample), String(sample));
});

// Not a test: keeps the McpTransport import used for type checks of custom transports.
export type _Transport = McpTransport;
