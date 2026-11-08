import { expect, test } from 'bun:test';
import { registerNightRuntime } from './night-runtime.js';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const goal = () => ({ goal_id: 'repair', outcome: 'Verified scoped repair', acceptance: ['Native tests pass'],
  roots: ['/workspace'], models: ['openai-codex/gpt-6.1-sol:high'], tiers: ['priority'], operations: ['edit'],
  resources: { memory_ceiling: 1073741824, runtime_seconds: 600, elastic: false, gpu: false },
  delivery: { branch: '', remote: '', actions: [] } });
const Type = { Object: value => value, String: () => ({}), Boolean: () => ({}),
  Optional: value => value, Union: value => value, Literal: value => value };

test('local contract dry-run uses the authoritative validator and never requests or replaces a grant', async () => {
  const tools = new Map(), operations = [];
  const previous = { id: 'previous-grant', request: { purpose: 'goal' } };
  let active = previous, authCalls = 0, launches = 0;
  const authority = { active: () => active, scopeParameters: {}, scopeHint: '',
    request: async () => { authCalls++; active = undefined; throw new Error('authentication must not run'); },
    transport: async (operation, payload) => {
      operations.push(operation);
      expect(operation).toBe('validate');
      const child = Bun.spawn(['python3', '-I', new URL('./client.py', import.meta.url).pathname,
        'validate', JSON.stringify(payload)], { stdout: 'pipe', stderr: 'pipe' });
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      return JSON.parse(output);
    },
  };
  registerNightRuntime({ typebox: { Type }, on() {}, registerCommand() {},
    registerTool(tool) { tools.set(tool.name, tool); } }, authority, {
      spawn() { launches++; throw new Error('dry-run must not launch an inhibitor or workload'); },
    });
  const tool = tools.get('owner_goal_request');
  const ctx = { cwd: '/workspace/task', sessionManager: { getSessionId: () => 'test-session' } };
  const params = { action: 'Complete scoped repair', exceptions: ['Bounded goal execution'], hours: '6',
    contract: JSON.stringify(goal()), validate_only: true };
  const result = await tool.execute('valid', params, undefined, undefined, ctx);
  expect(result.details).toMatchObject({ valid: true, authorization: false });
  const invalid = goal(); invalid.models = ['wrong']; invalid.resources.gpu = 'device';
  await expect(tool.execute('invalid', { ...params, validate_only: false, contract: JSON.stringify(invalid) },
    undefined, undefined, ctx)).rejects.toThrow('models');
  await expect(tool.execute('invalid-again', { ...params, contract: JSON.stringify(invalid) },
    undefined, undefined, ctx)).rejects.toThrow('resources.gpu');
  expect(active).toBe(previous);
  expect(authCalls).toBe(0);
  expect(launches).toBe(0);
  expect(operations).toEqual(['validate', 'validate', 'validate']);
});

test('completed resource results survive live-row eviction and remain scoped to the exact grant', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'night-receipts-'));
  const oldRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = directory;
  const tools = new Map(), entries = [], children = [];
  let grant = { id: 'grant-one', request: { purpose: 'goal', goal: { ...goal(), roots: [directory] },
    duration_seconds: 21600, session: 'test-session' } };
  const authority = { active: () => grant, verify: async () => {}, scopeParameters: {}, scopeHint: '',
    capability: () => ({ id: 'fixture-only', secret: 'not-a-real-capability' }),
    transport: async operation => {
      expect(operation).toBe('issue_descendant');
      return { id: 'fixture-only', secret: 'not-a-real-capability' };
    },
  };
  const api = { typebox: { Type }, on() {}, registerCommand() {}, sendMessage() {},
    registerTool(tool) { tools.set(tool.name, tool); },
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); },
    captureEntryWriter() {
      const origin = entries;
      return async (customType, data) => { origin.push({ type: 'custom', customType, data }); };
    },
  };
  registerNightRuntime(api, authority, { spawn() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { throw new Error('completed receipt must not control a process'); };
    children.push(child); return child;
  } });
  const ctx = { cwd: directory, sessionManager: { getBranch: () => entries, getSessionId: () => 'test-session' } };
  ctx.goal = { getState: () => ({ enabled: true, goal: { id: grant.request.goal.goal_id } }) };
  const call = data => tools.get('resource_job').execute('resource', { data: JSON.stringify(data) },
    undefined, undefined, ctx);
  try {
    let first;
    for (let index = 0; index < 65; index++) {
      const result = await call({ operation: 'submit', command: ['fixture-only'], cwd: directory,
        need: 268435456, runtime: 1 });
      first ??= result.details.job_id;
      children.at(-1).stdout.emit('data', Buffer.from(`result-${index}\n`));
      children.at(-1).emit('close', 0);
    }
    const retained = await call({ operation: 'status', job_id: first });
    expect(retained.details).toMatchObject({ job_id: first, retained: true, state: 'finished', exit: 0 });
    expect(retained.details.output).toContain('result-0');
    expect(children).toHaveLength(65);
    grant = { ...grant, id: 'different-grant' };
    await expect(call({ operation: 'status', job_id: first })).rejects.toThrow('Unknown owned job');
    expect(children).toHaveLength(65);
  } finally {
    if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = oldRuntime;
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(!process.env.OMP_TEST_HOST_ROOT)('late resource completion remains in its originating native journal after session switch', async () => {
  const { SessionManager } = await import(join(process.env.OMP_TEST_HOST_ROOT, 'packages/coding-agent/src/session/session-manager.ts'));
  const directory = await mkdtemp(join(tmpdir(), 'night-session-result-'));
  const oldRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = directory;
  const journal = SessionManager.create(directory, join(directory, 'sessions'));
  await journal.ensureOnDisk();
  const origin = journal.getSessionFile();
  const tools = new Map(), notifications = [], children = [];
  const persisted = Promise.withResolvers();
  let grant = { id: 'grant-one', request: { purpose: 'goal', goal: { ...goal(), roots: [directory] },
    duration_seconds: 21600, session: journal.getSessionId() } };
  const authority = { active: () => grant, verify: async () => {}, scopeParameters: {}, scopeHint: '',
    capability: () => ({ id: 'fixture-only', secret: 'not-a-real-capability' }),
    transport: async () => ({ id: 'fixture-only', secret: 'not-a-real-capability' }) };
  const api = { typebox: { Type }, on() {}, registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); },
    appendEntry(customType, data) { journal.appendCustomEntry(customType, data); },
    captureEntryWriter() {
      const write = journal.captureCustomEntryWriter();
      return async (...args) => { await write(...args); persisted.resolve(); };
    },
    sendMessage(message) { notifications.push(message); } };
  const night = registerNightRuntime(api, authority, { spawn() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => true;
    children.push(child); return child;
  } });
  try {
    const result = await tools.get('resource_job').execute('resource', { data: JSON.stringify({
      operation: 'submit', command: ['fixture-only'], cwd: directory, need: 268435456, runtime: 1,
    }) }, undefined, undefined, { cwd: directory, sessionManager: journal,
      goal: { getState: () => ({ enabled: true, goal: { id: grant.request.goal.goal_id } }) } });
    children[0].stdout.emit('data', Buffer.from('origin-only output'));
    grant = undefined;
    night.stop();
    await journal.newSession();
    children[0].emit('close', 0);
    await persisted.promise;
    expect(journal.getEntries().some(entry => entry.type === 'custom' && entry.customType === 'night-resource-result')).toBe(false);
    expect(notifications).toEqual([]);
    const reopened = await SessionManager.open(origin);
    try {
      const receipts = reopened.getEntries().filter(entry => entry.type === 'custom' && entry.customType === 'night-resource-result');
      expect(receipts).toHaveLength(1);
      expect(receipts[0].data).toMatchObject({ job_id: result.details.job_id, output: 'origin-only output' });
    } finally { await reopened.close(); }
  } finally {
    await journal.close();
    if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = oldRuntime;
    await rm(directory, { recursive: true, force: true });
  }
});
