import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OAuthProvider,
  Secret,
  authorizationUrl,
  checkState,
  discover,
  exchangeCode,
  memoryTokenStore,
  newState,
  validateMetadata,
  webhookDeduper,
} from '../src/index.js';

const good = {
  issuer: 'https://example.com',
  authorization_endpoint: 'https://example.com/oauth/authorize',
  token_endpoint: 'https://example.com/oauth/token',
  registration_endpoint: 'https://example.com/oauth/register',
  revocation_endpoint: 'https://example.com/oauth/revoke',
};
const served = (metadata: object) =>
  (async () => new Response(JSON.stringify(metadata), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

test('discovery refuses a foreign or plain-http token endpoint (and every other endpoint)', async () => {
  assert.deepEqual(await discover('https://example.com', served(good)), good);
  for (const [key, value] of [
    ['token_endpoint', 'https://attacker.example/oauth/token'],
    ['token_endpoint', 'http://example.com/oauth/token'],
    ['authorization_endpoint', 'https://attacker.example/authorize'],
    ['registration_endpoint', 'http://example.com/oauth/register'],
    ['revocation_endpoint', 'https://example.com.attacker.example/revoke'],
    ['issuer', 'https://attacker.example'],
    ['token_endpoint', 'https://user:pw@example.com/oauth/token'],
  ] as const)
    await assert.rejects(discover('https://example.com', served({ ...good, [key]: value })), /OAuth/, `${key}=${value}`);
  await assert.rejects(discover('http://example.com', served(good)), /https/);
  // Loopback development servers may use plain http, on one origin.
  const local = { issuer: 'http://127.0.0.1:4310', authorization_endpoint: 'http://127.0.0.1:4310/a', token_endpoint: 'http://127.0.0.1:4310/t' };
  assert.deepEqual(await discover('http://127.0.0.1:4310', served(local)), local);
});

test('metadata passed by hand is validated before any token request', async () => {
  let sent = 0;
  const fetchImpl = (async () => {
    sent++;
    return new Response('{}');
  }) as unknown as typeof fetch;
  const poisoned = { ...good, token_endpoint: 'https://attacker.example/token' };
  await assert.rejects(
    exchangeCode(poisoned, { clientId: 'c' }, { code: 'x', verifier: new Secret('v'.repeat(43)), redirectUri: 'http://127.0.0.1:1/cb', origin: 'https://example.com', scopes: [] }, fetchImpl),
    /token endpoint/,
  );
  assert.throws(
    () =>
      new OAuthProvider({
        metadata: { ...good, token_endpoint: 'http://example.com/oauth/token' },
        client: { clientId: 'c' },
        store: memoryTokenStore(),
        origin: 'https://example.com',
        fetch: fetchImpl,
      }),
    /https/,
  );
  assert.equal(sent, 0, 'nothing reached a refused endpoint');
  assert.throws(() => validateMetadata(good, 'https://other.example'), /issuer/);
});

test('state: the caller generates and checks it', () => {
  const state = newState();
  assert.ok(state.length >= 32);
  assert.notEqual(newState(), state);
  assert.equal(checkState(state, state), true);
  assert.equal(checkState(state, `${state.slice(0, -1)}x`), false);
  assert.equal(checkState(state, null), false);
  assert.throws(
    () => authorizationUrl(good, { clientId: 'c', redirectUri: 'http://127.0.0.1:1/cb', scopes: [], state: 'short', challenge: 'c'.repeat(43), origin: 'https://example.com' }),
    /state/,
  );
});

test('webhookDeduper remembers ids for at least 300 s', () => {
  let t = 0;
  const dedupe = webhookDeduper({ ttlSeconds: 10, now: () => t });
  assert.equal(dedupe.duplicate('msg_1'), false);
  assert.equal(dedupe.duplicate('msg_1'), true);
  t = 299_000;
  assert.equal(dedupe.duplicate('msg_1'), true, 'the window never drops below 300 s');
  t = 301_000;
  assert.equal(dedupe.duplicate('msg_1'), false);
  assert.equal(dedupe.duplicate(undefined), false);
});
