import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkedSignal } from '../src/internal/signals.js';

test('linkedSignal: aborts on a parent, on the timeout, and not after dispose', async () => {
  const parent = new AbortController();
  const a = linkedSignal([parent.signal]);
  parent.abort('stop');
  assert.equal(a.signal.aborted, true);
  assert.equal(a.signal.reason, 'stop');

  const b = linkedSignal([undefined], 20);
  await new Promise((resolve) => b.signal.addEventListener('abort', resolve, { once: true }));
  assert.equal((b.signal.reason as DOMException).name, 'TimeoutError');

  const other = new AbortController();
  const c = linkedSignal([other.signal], 20);
  c.dispose();
  other.abort();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(c.signal.aborted, false);

  const pre = new AbortController();
  pre.abort('early');
  assert.equal(linkedSignal([pre.signal], 1000).signal.aborted, true);
});
