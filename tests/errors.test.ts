import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromHttpError, fromStreamError, fromToolError, isCodedIssue } from '../src/errors.js';

const headers = (values: Record<string, string> = {}) => new Headers(values);
const tool = (error: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ error }) }] });

test('tool errors: code, retry_after_ms, issues and classification', () => {
  const limited = fromToolError(
    tool({ code: 'rate_limited', message: 'Too many.', retryable: true, retry_after_ms: 1500 }),
  );
  assert.equal(limited.kind, 'rate_limit');
  assert.equal(limited.retryable, true);
  assert.equal(limited.retryAfterMs, 1500);
  const capacity = fromToolError(tool({ code: 'too_many_rooms', message: 'x', retryable: false }));
  assert.equal(capacity.kind, 'capacity');
  assert.equal(capacity.retryable, false);
  const invalid = fromToolError(
    tool({
      code: 'invalid_arguments',
      message: 'Check these fields: text (Required).',
      issues: [{ path: 'text', message: 'Required' }],
    }),
  );
  assert.equal(invalid.kind, 'validation');
  assert.deepEqual(invalid.issues, [{ path: 'text', message: 'Required' }]);
  assert.equal(isCodedIssue(invalid.issues![0]!), false);
  const approval = fromToolError(
    tool({
      code: 'forbidden',
      message: 'Needs approval.',
      issues: [{ code: 'OWNER_APPROVAL_REQUIRED', path: 'spec', message: 'm', hint: 'h' }],
    }),
  );
  assert.equal(approval.kind, 'approval_required');
  assert.equal(fromToolError({ content: [{ type: 'text', text: 'not json' }] }).code, 'unknown');
  const scope = fromToolError(tool({ code: 'insufficient_scope', message: 'Needs rooms:host.' }));
  assert.equal(scope.kind, 'scope');
});

test('429s: allowlisted codes and uncoded 429s are rate limits; other coded 429s are capacity', () => {
  for (const code of ['rate_limited', 'inbox_full', 'remote_quota'])
    assert.equal(fromHttpError(429, { error: 'x', code }, headers()).kind, 'rate_limit', code);
  for (const code of [
    'too_many_rooms',
    'room_storage_full',
    'too_many_invites',
    'cooldown',
    'too_many_pending',
    'webhook_limit',
    'stream_limit',
    'publish_cap',
    'something_new',
  ]) {
    const error = fromHttpError(429, { error: 'x', code }, headers({ 'retry-after': '3600' }));
    assert.equal(error.kind, 'capacity', code);
    assert.equal(error.retryable, false, code);
    assert.equal(error.retryAfterMs, 3_600_000, code);
  }
  // The generic limiter (runtime 120/min, wake budgets, IP limit, /mcp per credential): no code.
  const uncoded = fromHttpError(
    429,
    { error: 'Too many requests. Try again later.' },
    headers({ 'Retry-After': '12' }),
  );
  assert.equal(uncoded.kind, 'rate_limit');
  assert.equal(uncoded.retryable, true);
  assert.equal(uncoded.retryAfterMs, 12_000);
  const replay = fromHttpError(429, { error: 'Runtime replay capacity reached.' }, headers());
  assert.equal(replay.code, 'runtime_replay_capacity');
  assert.equal(replay.kind, 'rate_limit');
  const askTimeout = fromHttpError(503, { error: 'x', code: 'ask_timeout' }, headers());
  assert.equal(askTimeout.kind, 'rate_limit');
});

test('REST validation, OAuth, JSON-RPC bodies, scope challenge and runtime 409s', () => {
  const validation = fromHttpError(
    400,
    { error: 'Check these fields: name (Required).', code: 'invalid_request', issues: [{ path: 'name', message: 'Required' }] },
    headers(),
  );
  assert.equal(validation.kind, 'validation');
  assert.equal(validation.issues?.length, 1);
  const oauth = fromHttpError(
    401,
    { error: 'invalid_token', error_description: 'The access token is invalid.' },
    headers(),
  );
  assert.equal(oauth.code, 'invalid_token');
  assert.equal(oauth.kind, 'auth');
  const rpc = fromHttpError(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch.' } }, headers());
  assert.equal(rpc.kind, 'validation');
  const scope = fromHttpError(
    403,
    { error: 'Insufficient scope.' },
    headers({
      'www-authenticate': 'Bearer error="insufficient_scope", scope="workspace:read rooms:host"',
    }),
  );
  assert.equal(scope.kind, 'scope');
  assert.deepEqual(scope.requiredScopes, ['workspace:read', 'rooms:host']);
  const stale = fromHttpError(409, { error: 'Heartbeat sequence must increase.' }, headers());
  assert.equal(stale.code, 'runtime_sequence_stale');
  const paused = fromHttpError(409, { error: 'Workspace is paused. Retry after it resumes.' }, headers());
  assert.equal(paused.kind, 'paused');
  const quota = fromHttpError(
    409,
    { error: 'Quota.', issues: [{ code: 'QUOTA_EXCEEDED', path: 'spec', message: 'm' }] },
    headers(),
  );
  assert.equal(quota.kind, 'quota_exceeded');
  assert.equal(fromHttpError(500, { error: 'x' }, headers()).kind, 'server');
});

test('stream error events: a rejected fallback is classified by status', () => {
  assert.equal(fromStreamError({ status: 403, code: 'insufficient_scope', message: 'm' }).kind, 'scope');
  assert.equal(fromStreamError({ status: 404, code: 'rejected', message: 'm' }).kind, 'not_found');
  assert.equal(fromStreamError({ status: 500, code: 'internal_error', message: 'm' }).kind, 'server');
});

test('server text is cleaned: control characters removed, 1 KiB cap, no bodies or headers kept', () => {
  const error = fromHttpError(
    404,
    { error: `Agent \u0007"${'x'.repeat(5000)}" not found`, secret_field: 'ccw_should_not_appear' },
    headers({ authorization: 'Bearer should-not-appear' }),
  );
  assert.ok(error.serverMessage.length <= 1024);
  assert.ok(!error.serverMessage.includes('\u0007'));
  const dumped = JSON.stringify(error) + String(error) + error.stack;
  assert.ok(!dumped.includes('should_not_appear') && !dumped.includes('should-not-appear'));
});

test('a plain-text MCP input validation error is invalid_arguments', () => {
  const error = fromToolError({
    content: [{ type: 'text', text: 'Input validation error: Invalid arguments for tool city_send_message: from_agent_id: Invalid UUID' }],
  });
  assert.equal(error.code, 'invalid_arguments');
  assert.equal(error.kind, 'validation');
  assert.match(String(error.serverMessage), /from_agent_id/);
});

test('room task claim races are conflicts', () => {
  for (const code of ['task_claimed', 'claim_stale']) {
    const error = fromHttpError(409, { error: 'x', code }, new Headers());
    assert.equal(error.kind, 'conflict', code);
    assert.equal(error.code, code);
  }
});
