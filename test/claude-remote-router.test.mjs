import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteExecutorRouter } from '../desktop/agents/remote-executor-router.mjs';

function fixture(getDefaultProvider) {
  const calls = [];
  const executor = (provider) => Object.fromEntries(['start', 'resume'].map((method) => [method, async (input) => {
    calls.push({ provider, method, input });
    return { provider, input };
  }]));
  return { calls, router: new RemoteExecutorRouter({ codex: executor('codex'), claude: executor('claude'), getDefaultProvider }) };
}

test('router isolates namespaced sessions and keeps legacy bare IDs on Codex', async () => {
  const { router, calls } = fixture(() => 'claude');
  for (const sessionId of ['claude:abc', 'codex:abc', 'legacy-id']) await router.resume({ sessionId });
  assert.deepEqual(calls.map((c) => c.provider), ['claude', 'codex', 'codex']);
  assert.equal(calls[0].input.sessionId, 'claude:abc');
  assert.equal(calls[1].input.sessionId, 'abc');
});

test('start uses explicit provider, configured default, then unchanged Codex default', async () => {
  const { router, calls } = fixture(() => 'claude');
  await router.start({ prompt: 'a' });
  await router.start({ providerId: 'codex' });
  assert.deepEqual(calls.map((c) => c.provider), ['claude', 'codex']);
  const fallback = fixture();
  await fallback.router.start({});
  assert.equal(fallback.calls[0].provider, 'codex');
});

test('router passes callbacks, signals and Claude input without stripping namespace', async () => {
  const { router, calls } = fixture();
  const controller = new AbortController();
  const input = { providerId: 'claude', sessionId: 'claude:abc', signal: controller.signal, onThreadStarted() {}, onUsage() {} };
  await router.resume(input);
  assert.equal(calls[0].input, input);
  controller.abort();
  assert.equal(calls[0].input.signal.aborted, true);
});

test('router refuses unknown providers, prefixes, empty IDs and source conflicts before dispatch', async () => {
  const { router, calls } = fixture();
  for (const input of [
    { sessionId: 'other:a' }, { sessionId: 'claude:a', providerId: 'codex' },
    { sessionId: 'codex:a', providerId: 'claude' }, { sessionId: 'legacy', providerId: 'claude' },
    { sessionId: 'claude:' }, { sessionId: '' }, { sessionId: 'legacy', providerId: 'other' },
  ]) await assert.rejects(router.resume(input));
  await assert.rejects(router.start({ providerId: 'other' }));
  await assert.rejects(router.start({ providerId: 'claude', sessionId: 'codex:a' }));
  await assert.rejects(fixture(() => 'other').router.start({}));
  assert.equal(calls.length, 0);
});
