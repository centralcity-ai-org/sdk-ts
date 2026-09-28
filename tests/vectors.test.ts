import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runtimeHeaders, runtimeSignature } from '../src/runtime/index.js';
import { signWebhook, verifyWebhook } from '../src/webhooks.js';

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`./vectors/${name}`, import.meta.url), 'utf8'));

test('runtime HMAC matches the reference implementation byte for byte', async () => {
  const { vectors } = load('runtime-hmac.json');
  assert.ok(vectors.length >= 5);
  for (const v of vectors) {
    const { signature } = await runtimeSignature({
      token: v.token,
      method: v.method,
      path: v.path,
      body: v.body,
      timestamp: v.timestamp,
      nonce: v.nonce,
    });
    assert.equal(signature, v.expected, `${v.method} ${v.path}`);
  }
});

test('runtime headers carry the signature, timestamp, nonce and JSON content type', async () => {
  const [v] = load('runtime-hmac.json').vectors;
  const headers = await runtimeHeaders({ ...v, token: v.token });
  assert.equal(headers['X-CC-Signature'], v.expected);
  assert.equal(headers['X-CC-Timestamp'], v.timestamp);
  assert.equal(headers['X-CC-Nonce'], v.nonce);
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers.Authorization, `Bearer ${v.token}`);
  const fresh = await runtimeSignature({ token: v.token, method: 'GET', path: '/api/runtime/jobs' });
  assert.match(fresh.timestamp, /^\d{13}$/);
  assert.match(fresh.nonce, /^[A-Za-z0-9_-]{16,128}$/);
  await assert.rejects(runtimeSignature({ ...v, nonce: 'short' }), /nonce/);
  await assert.rejects(runtimeSignature({ ...v, timestamp: '17' }), /timestamp/);
});

test('webhook signatures and verdicts match the reference implementation', async () => {
  const w = load('webhooks.json');
  assert.equal(
    await signWebhook(w.cases[0].secret, w.signatures.id, w.signatures.timestamp, w.signatures.body),
    w.signatures.secretA,
  );
  assert.equal(
    await signWebhook(w.cases[2].secret, w.signatures.id, w.signatures.timestamp, w.signatures.body),
    w.signatures.secretB,
  );
  for (const c of w.cases)
    assert.equal(
      await verifyWebhook(c.secret, c.headers, c.body, { nowSeconds: c.now }),
      c.valid,
      c.name,
    );
});

test('verifyWebhook accepts a Headers object and any header case', async () => {
  const w = load('webhooks.json');
  const c = w.cases[0];
  const headers = new Headers({
    'Webhook-Id': c.headers['webhook-id'],
    'WEBHOOK-TIMESTAMP': c.headers['webhook-timestamp'],
    'webhook-signature': c.headers['webhook-signature'],
  });
  assert.equal(await verifyWebhook(c.secret, headers, c.body, { nowSeconds: c.now }), true);
  assert.equal(await verifyWebhook('whsec_%%%', headers, c.body, { nowSeconds: c.now }), false);
});
