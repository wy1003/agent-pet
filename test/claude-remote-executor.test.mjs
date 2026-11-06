import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, link, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClaudeRemoteExecutor } from '../desktop/claude/remote-executor.mjs';
import { buildRemoteRequest } from '../src/remote-request.mjs';

const init = (id = '11111111-1111-4111-8111-111111111111') => ({ type: 'system', subtype: 'init', session_id: id });
const success = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, session_id: '11111111-1111-4111-8111-111111111111', result: ' done ', usage: { input_tokens: 7 }, permission_denials: [], ...extra });
const assistant = { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }], usage: { output_tokens: 1 } } };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pet-claude-executor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  await mkdir(cwd);
  return { root, cwd: await realpath(cwd), prompt: '修复问题', onThreadStarted: async () => {} };
}
function fakeQuery(events, observe = () => {}) {
  return (input) => {
    observe(input);
    const stream = (async function* () { for (const event of events) { if (event instanceof Error) throw event; yield event; } })();
    stream.interrupt = async () => {};
    return stream;
  };
}
function executor(query, extra = {}) { return new ClaudeRemoteExecutor({ query, sessionIdFactory: () => '11111111-1111-4111-8111-111111111111', isSessionActive: async () => false, ...extra }); }

test('start persists the preallocated UUID before dispatching the prompt and returns Codex contract plus provenance', async (t) => {
  const value = await fixture(t);
  let persisted = false;
  let captured;
  const usageEvents = [];
  const query = (input) => {
    assert.equal(persisted, true, 'query must not receive the prompt before durable session persistence');
    assert.equal(input.options.sessionId, '11111111-1111-4111-8111-111111111111');
    captured = input;
    return (async function* () {
      yield init();
      assert.equal(persisted, true);
      yield assistant;
      yield { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } };
      yield success();
    })();
  };
  const result = await executor(query).start({ ...value, onUsage: (entry) => usageEvents.push(entry), onThreadStarted: async (...args) => {
    assert.deepEqual(args, ['claude:11111111-1111-4111-8111-111111111111']);
    await new Promise((resolve) => setImmediate(resolve));
    persisted = true;
  } });
  assert.deepEqual(result, { sessionId: 'claude:11111111-1111-4111-8111-111111111111', finalResponse: 'done', usage: { input_tokens: 7 }, providerId: 'claude', nativeSessionId: '11111111-1111-4111-8111-111111111111', route: 'sdk' });
  assert.equal(captured.prompt, buildRemoteRequest(value.prompt));
  assert.equal(captured.options.cwd, value.cwd);
  assert.equal(captured.options.persistSession, true);
  assert.equal(captured.options.resume, undefined);
  assert.equal(captured.options.model, undefined);
  assert.deepEqual(captured.options.systemPrompt, { type: 'preset', preset: 'claude_code' });
  assert.deepEqual(usageEvents.map((e) => e.type), ['assistant', 'rate_limit_event', 'result']);
});

test('start validation rejects missing persistence, prompt and directory before query', async (t) => {
  const value = await fixture(t);
  let calls = 0;
  const ex = executor(() => { calls++; throw new Error('should not query'); });
  await assert.rejects(ex.start({ ...value, onThreadStarted: undefined }));
  await assert.rejects(ex.start({ ...value, cwd: '' }));
  await assert.rejects(ex.start({ ...value, cwd: path.join(value.cwd, 'missing') }));
  await assert.rejects(ex.start({ ...value, prompt: ' ' }));
  assert.equal(calls, 0);
});

test('persistence failure prevents SDK dispatch entirely and emits no lifecycle', async (t) => {
  const value = await fixture(t);
  let calls = 0;
  const events = [];
  await assert.rejects(executor(() => { calls++; return fakeQuery([init(), success()])({}); }, {
    emitEvent: event => events.push(event),
  }).start({ ...value, onThreadStarted: async () => { throw new Error('disk full'); } }),
  e => e.message.includes('disk full') && e.submissionState === 'not-submitted');
  assert.equal(calls, 0);
  assert.deepEqual(events, []);
});

test('resume tries original client first with unchanged callbacks and uses valid result without SDK', async (t) => {
  const value = { ...await fixture(t), sessionId: 'claude:11111111-1111-4111-8111-111111111111', signal: new AbortController().signal };
  let originalInput;
  const ex = executor(() => { throw new Error('SDK must not run'); }, {
    isSessionActive: () => { throw new Error('must not inspect owner on original route'); },
    originalClient: { tryResume: async (input) => { originalInput = input; return { sessionId: value.sessionId, finalResponse: 'original result', usage: null }; } },
  });
  const result = await ex.resume(value);
  assert.equal(result.finalResponse, 'original result');
  assert.equal(result.route, 'original-client');
  assert.equal(originalInput.signal, value.signal);
  assert.equal(originalInput.onThreadStarted, value.onThreadStarted);
  assert.equal(originalInput.input, buildRemoteRequest(value.prompt));
});

test('only explicit null permits SDK fallback and SDK receives raw resume ID', async (t) => {
  const value = { ...await fixture(t), sessionId: 'claude:11111111-1111-4111-8111-111111111111' };
  const order = [];
  let input;
  const ex = executor(fakeQuery([init(), success()], (v) => { order.push('sdk'); input = v; }), {
    originalClient: { tryResume: async () => { order.push('original'); return null; } },
    isSessionActive: async (id) => { assert.equal(id, '11111111-1111-4111-8111-111111111111'); order.push('inactive'); return false; },
  });
  assert.equal((await ex.resume(value)).sessionId, value.sessionId);
  assert.equal(input.options.resume, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(order, ['original', 'inactive', 'sdk']);
});

test('original errors and indeterminate responses never resend via SDK', async (t) => {
  const value = { ...await fixture(t), sessionId: 'claude:11111111-1111-4111-8111-111111111111' };
  let calls = 0;
  for (const response of [undefined, false, {}, { submitted: true }, { sessionId: 'claude:wrong', finalResponse: 'x' }, new Error('timeout')]) {
    const ex = executor(() => { calls++; }, { originalClient: { tryResume: async () => { if (response instanceof Error) throw response; return response; } } });
    await assert.rejects(ex.resume(value), (e) => e.route === 'original-client' && e.safeToRetry === false && typeof e.turnStarted === 'boolean');
  }
  assert.equal(calls, 0);
});

test('active or unknown CLI/VSCode ownership fails closed, including missing detector', async (t) => {
  const value = { ...await fixture(t), sessionId: 'claude:11111111-1111-4111-8111-111111111111' };
  let calls = 0;
  for (const state of [true, undefined, null, 'inactive', new Error('unknown')]) {
    const ex = executor(() => { calls++; }, { isSessionActive: async () => { if (state instanceof Error) throw state; return state; } });
    await assert.rejects(ex.resume(value));
  }
  await assert.rejects(new ClaudeRemoteExecutor({ query: () => { calls++; } }).resume(value));
  assert.equal(calls, 0);
  assert.equal(new ClaudeRemoteExecutor().capabilities.originalWindow, false);
  assert.equal(new ClaudeRemoteExecutor().capabilities.osSandbox, false);
});

test('invalid, foreign and mismatched session IDs are rejected', async (t) => {
  const value = await fixture(t);
  for (const sessionId of ['11111111-1111-4111-8111-111111111111', 'codex:11111111-1111-4111-8111-111111111111', 'claude:', 'claude:../escape', 'claude:a:b']) {
    await assert.rejects(executor(() => assert.fail('no SDK')).resume({ ...value, sessionId }));
  }
  await assert.rejects(executor(fakeQuery([init('wrong'), success()])).resume({ ...value, sessionId: 'claude:11111111-1111-4111-8111-111111111111' }));
});

test('failure results, permission denials and truncated streams cannot be reported as success', async (t) => {
  const value = await fixture(t);
  for (const events of [
    [init(), assistant, { ...success(), subtype: 'error_during_execution', is_error: true, errors: ['timeout'] }],
    [init(), assistant, success({ is_error: true })],
    [init(), assistant, success({ permission_denials: [{ tool_name: 'Bash' }] })],
    [init(), assistant, new Error('socket failed')],
    [init(), assistant],
    [assistant, success()],
    [init(), success({ session_id: 'wrong' })],
  ]) await assert.rejects(executor(fakeQuery(events)).start(value), (e) => typeof e.turnStarted === 'boolean' && e.safeToRetry === false);
  await assert.rejects(executor(fakeQuery([init(), assistant, new Error('timeout')])).start(value), (e) => e.turnStarted === true && e.transient !== true);
  await assert.rejects(executor(() => { throw new Error('dispatch timeout'); }).start(value), (e) => e.safeToRetry === false && e.turnStarted === false);
});

test('pre-aborted signal prevents dispatch, in-flight abort interrupts only its SDK query', async (t) => {
  const value = await fixture(t);
  const pre = new AbortController(); pre.abort();
  await assert.rejects(executor(() => assert.fail('no query')).start({ ...value, signal: pre.signal }), { name: 'AbortError' });
  const controller = new AbortController();
  let options;
  let interrupted = 0;
  const query = (input) => {
    options = input.options;
    return { [Symbol.asyncIterator]() { return this; }, next() { setImmediate(() => controller.abort()); return new Promise(() => {}); }, interrupt: async () => { interrupted++; } };
  };
  await assert.rejects(executor(query).start({ ...value, signal: controller.signal }), (e) => e.name === 'AbortError' && e.safeToRetry === false);
  assert.equal(options.abortController.signal.aborted, true);
  assert.equal(interrupted, 1);
});

test('SDK configuration keeps CLAUDE.md support without user hooks, MCP or bypass permissions', async (t) => {
  const value = await fixture(t);
  let options;
  await executor(fakeQuery([init(), success()], (input) => { options = input.options; })).start(value);
  assert.deepEqual(options.settingSources, ['project']);
  assert.equal(options.settings.disableAllHooks, true);
  assert.equal(options.settings.autoMemoryEnabled, false);
  assert.equal(options.settings.disableClaudeAiConnectors, true);
  assert.equal(options.settings.syncClaudeAiSkills, false);
  assert.equal(options.settings.syncClaudeAiPlugins, false);
  for (const key of ['apiKeyHelper', 'proxyAuthHelper', 'awsCredentialExport', 'awsAuthRefresh', 'gcpAuthRefresh']) assert.equal(options.settings[key], '');
  assert.equal(options.permissionMode, 'default');
  assert.equal(options.allowDangerouslySkipPermissions, false);
  assert.deepEqual(options.tools, ['Read', 'Glob', 'Grep', 'Edit', 'Write']);
  assert.deepEqual(options.settings.permissions.ask, options.tools);
  assert.equal(options.settings.permissions.blockReadsOutsideWorkingDirectories, true);
  assert.equal(options.settings.permissions.blockWritesOutsideWorkingDirectories, true);
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.mcpServers, {});
  assert.deepEqual(options.agents, {});
  assert.deepEqual(options.skills, []);
});

test('tool authorization rejects traversal, foreign absolute paths, prefixes, forbidden tools and special paths', async (t) => {
  const value = await fixture(t);
  let canUseTool;
  await executor(fakeQuery([init(), success()], ({ options }) => { canUseTool = options.canUseTool; })).start(value);
  for (const file_path of ['../escape', '..\\escape', path.join(value.root, 'project-evil', 'file'), path.join(value.root, 'outside'), 'C:\\outside\\x', '\\\\server\\share\\x', 'file:stream', '.claude/settings.json', '.git/config']) {
    assert.equal((await canUseTool('Write', { file_path, content: 'x' })).behavior, 'deny', file_path);
  }
  for (const name of ['Bash', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Workflow', 'Skill', 'mcp__server__tool']) assert.equal((await canUseTool(name, {})).behavior, 'deny', name);
  assert.equal((await canUseTool('Write', { file_path: path.join(value.cwd, 'new', 'file.txt'), content: 'x' })).behavior, 'allow');
  assert.equal((await canUseTool('Edit', { file_path: 'file.txt', old_string: 'x', new_string: 'y' })).behavior, 'allow');
  assert.equal((await canUseTool('Read', { file_path: path.join(value.cwd, 'file.txt') })).behavior, 'allow');
  assert.equal((await canUseTool('Glob', { pattern: '../*' })).behavior, 'deny');
  assert.equal((await canUseTool('Glob', { pattern: '{..,src}/**/*' })).behavior, 'deny');
  assert.equal((await canUseTool('Grep', { pattern: 'x', path: '../' })).behavior, 'deny');
  assert.equal((await canUseTool('Glob', { pattern: '**/*.mjs' })).behavior, 'allow');
  assert.equal((await canUseTool('Grep', { pattern: 'x' })).behavior, 'allow');
});

test('SDK emits correlated managed Hook events after persistence, with one terminal event and one release', async (t) => {
  const value = await fixture(t);
  const events = [];
  let persisted = false;
  await executor(fakeQuery([init(), assistant, success()]), { onEvent: async (event) => {
    assert.equal(persisted, true);
    events.push(event);
  } }).start({ ...value, onThreadStarted: async () => { persisted = true; } });
  assert.deepEqual(events.map((e) => e.hook_event_name), ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']);
  assert.equal(new Set(events.map((e) => e.event_id)).size, 4);
  assert.equal(new Set(events.map((e) => e.prompt_id)).size, 1);
  for (const event of events) {
    assert.equal(event.session_id, '11111111-1111-4111-8111-111111111111');
    assert.equal(event.cwd, value.cwd);
    assert.equal(event.managed_by, 'AGENT_PET');
    assert.equal(event.source, 'agent-pet-remote');
    assert.ok(Number.isFinite(Date.parse(event.timestamp)));
    assert.ok(event.prompt_id);
  }
  assert.equal(events[1].prompt, buildRemoteRequest(value.prompt));
  assert.equal(events[2].last_assistant_message, 'done');
});

test('SDK failure emits StopFailure, cancellation emits no completion, both release ownership', async (t) => {
  const value = await fixture(t);
  for (const cancel of [false, true]) {
    const events = [];
    const controller = new AbortController();
    const query = () => (async function* () {
      yield init();
      yield assistant;
      if (cancel) controller.abort();
      throw new Error(cancel ? 'cancelled stream' : 'timeout');
    })();
    await assert.rejects(executor(query, { onEvent: (event) => events.push(event) }).start({ ...value, signal: controller.signal }));
    assert.deepEqual(events.map((e) => e.hook_event_name), cancel
      ? ['SessionStart', 'UserPromptSubmit', 'SessionEnd']
      : ['SessionStart', 'UserPromptSubmit', 'StopFailure', 'SessionEnd']);
    assert.equal(events.at(-1).reason, cancel ? 'cancelled' : 'failed');
  }
});

test('original-client hits never emit synthetic SDK lifecycle events', async (t) => {
  const value = { ...await fixture(t), sessionId: 'claude:11111111-1111-4111-8111-111111111111' };
  const events = [];
  const result = await executor(() => assert.fail('no SDK'), {
    onEvent: (event) => events.push(event),
    originalClient: { tryResume: async () => ({ sessionId: value.sessionId, finalResponse: ' original ', usage: null }) },
  }).resume(value);
  assert.deepEqual(events, []);
  assert.equal(result.finalResponse, ' original ');
});

test('SDK lifecycle deduplicates init and terminal results', async (t) => {
  const value = await fixture(t);
  const events = [];
  let persisted = 0;
  const result = await executor(fakeQuery([init(), init(), success(), success()]), {
    emitEvent: async event => { events.push(event); },
  }).start({ ...value, onThreadStarted: async () => { persisted++; } });
  assert.equal(result.finalResponse, 'done');
  assert.equal(persisted, 1);
  assert.deepEqual(events.map(e => e.hook_event_name), ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']);
  assert.equal(events.at(-1).reason, 'completed');
});

test('persistence rejection and cancellation before persistence emit no managed lifecycle', async (t) => {
  const value = await fixture(t);
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const events = [];
    await assert.rejects(executor(fakeQuery([init(), success()]), { emitEvent: event => events.push(event) }).start({
      ...value, signal: controller.signal, onThreadStarted: async () => {
        if (cancel) controller.abort();
        else throw new Error('persistence failed');
      },
    }));
    assert.deepEqual(events, []);
  }
});

test('failure and cancellation release managed ownership even when the event sink rejects', async (t) => {
  const value = await fixture(t);
  for (const cancel of [false, true]) {
    const events = [];
    const controller = new AbortController();
    const query = () => (async function* () {
      yield init();
      if (cancel) controller.abort();
      throw new Error('stream failed');
    })();
    await assert.rejects(executor(query, { emitEvent: async event => {
      events.push(event);
      if (event.hook_event_name === 'StopFailure' || event.hook_event_name === 'SessionEnd') throw new Error('observer unavailable');
    } }).start({ ...value, signal: controller.signal }), error => !cancel || error.name === 'AbortError');
    assert.deepEqual(events.map(e => e.hook_event_name), cancel
      ? ['SessionStart', 'UserPromptSubmit', 'SessionEnd']
      : ['SessionStart', 'UserPromptSubmit', 'StopFailure', 'SessionEnd']);
  }
});

test('start event sink rejection prevents prompt dispatch and attempts release once', async (t) => {
  const value = await fixture(t);
  for (const rejected of ['SessionStart', 'UserPromptSubmit']) {
    const events = [];
    let calls = 0;
    await assert.rejects(executor(() => { calls++; return fakeQuery([init(), success()])({}); }, {
      emitEvent: async event => {
        events.push(event);
        if ([rejected, 'SessionEnd'].includes(event.hook_event_name)) throw new Error('event sink unavailable');
      },
    }).start(value), error => error.code === 'claude_event_delivery_failed' && error.submissionState === 'not-submitted');
    assert.equal(calls, 0);
    assert.equal(events.filter(e => e.hook_event_name === 'SessionEnd').length, 1);
    assert.equal(events.filter(e => e.hook_event_name === rejected).length, 1);
    assert.equal(events.some(e => e.hook_event_name === 'Stop'), false);
    assert.equal(events.at(-1).reason, 'failed');
  }
});

test('terminal event rejection never emits a second terminal event or replays a result', async (t) => {
  const value = await fixture(t);
  for (const rejected of ['Stop', 'SessionEnd']) {
    const events = [];
    await assert.rejects(executor(fakeQuery([init(), success()]), { emitEvent: event => {
      events.push(event);
      if (event.hook_event_name === rejected) throw new Error('secret terminal delivery details');
    } }).start(value), e => e.safeToRetry === false && e.submissionState !== 'not-submitted' && e.code === 'claude_event_delivery_failed' && !e.message.includes('secret'));
    assert.deepEqual(events.map(e => e.hook_event_name), ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']);
  }
});

test('new session refuses an init ID other than the persisted and requested UUID', async (t) => {
  const value = await fixture(t);
  await assert.rejects(executor(fakeQuery([init('different-id'), success()])).start(value), /会话 ID/);
});

test('recursive searches reject hardlinked ordinary files as well as direct reads', async (t) => {
  const value = await fixture(t);
  const outside = path.join(value.root, 'outside.txt');
  await writeFile(outside, 'secret outside project');
  await mkdir(path.join(value.cwd, 'nested'));
  await link(outside, path.join(value.cwd, 'nested', 'hardlink.txt'));
  let canUseTool;
  await executor(fakeQuery([init(), success()], ({ options }) => { canUseTool = options.canUseTool; })).start(value);
  assert.equal((await canUseTool('Read', { file_path: 'nested/hardlink.txt' })).behavior, 'deny');
  assert.equal((await canUseTool('Grep', { pattern: 'secret', path: value.cwd })).behavior, 'deny');
  assert.equal((await canUseTool('Glob', { pattern: '**/*' })).behavior, 'deny');
});

test('symlink/junction and missing descendants cannot escape; recursive search fails closed on links', async (t) => {
  const value = await fixture(t);
  const outside = path.join(value.root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret'), 'fixture only');
  await symlink(outside, path.join(value.cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  let canUseTool;
  await executor(fakeQuery([init(), success()], ({ options }) => { canUseTool = options.canUseTool; })).start(value);
  for (const name of ['Read', 'Edit', 'Write']) {
    for (const file_path of ['link/secret', 'link/not-created/nested.txt']) assert.equal((await canUseTool(name, { file_path })).behavior, 'deny');
  }
  assert.equal((await canUseTool('Glob', { pattern: '**/*' })).behavior, 'deny');
  assert.equal((await canUseTool('Grep', { pattern: 'secret', path: value.cwd })).behavior, 'deny');
});
