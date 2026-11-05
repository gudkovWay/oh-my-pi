import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { GoalRuntime } from '../../packages/coding-agent/src/goals/runtime';
import { registerNightRuntime } from './night-runtime.js';

function setup() {
  const hooks = new Map(), tools = new Map(), commands = new Map(), messages = [], entries = [];
  let state, grant, revocations = 0, requests = 0;
  const ctx = { cwd: '/workspace', agent: { kind: 'main' }, sessionManager: {
    getSessionId: () => 'session', getBranch: () => entries,
  } };
  ctx.models = { resolve: spec => ({ provider: spec.split('/')[0], id: spec.slice(spec.indexOf('/') + 1, spec.lastIndexOf(':')) }) };
  const api = { typebox: { Type: { Object: x => x, String: () => ({}), Boolean: () => ({}), Optional: x => x, Union: x => x, Literal: x => x } },
    on: (name, fn) => hooks.set(name, fn), registerTool: t => tools.set(t.name, t),
    registerCommand: (name, command) => commands.set(name, command),
    sendMessage: (...message) => messages.push(message),
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
  };
  const runtime = new GoalRuntime({ getState: () => state, setState: x => { state = x; },
    getCurrentUsage: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), emit() {}, persist() {},
    sendHiddenMessage: async () => {}, transition: async event => {
      const result = await hooks.get('goal_transition')?.(event, ctx);
      if (result?.block) throw new Error(result.reason);
    } });
  ctx.goal = runtime;
  const authority = { active: () => grant, scopeParameters: {}, scopeHint: '',
    verify: async expected => { if (!grant || grant !== expected) throw new Error('revoked'); },
    transport: async () => ({ valid: true, authorization: false }),
    request: async params => { requests++; grant = { id: 'grant', request: { ...params, session: 'session' } }; return { remaining_seconds: 21600 }; },
    revoke: async () => { grant = undefined; revocations++; night.stop(); },
  };
  const night = registerNightRuntime(api, authority, { spawn() { const p = new EventEmitter(); p.kill = () => true; return p; },
    setTimeout: () => ({ unref() {} }), clearTimeout() {} });
  const contract = () => ({ goal_id: state.goal.id, outcome: state.goal.objective, acceptance: ['Tested'], roots: ['/workspace'],
    models: ['openai-codex/gpt-6-astra:high'], tiers: ['default'], operations: ['edit'],
    resources: { memory_ceiling: 1073741824, runtime_seconds: 600, elastic: false, gpu: false },
    delivery: { branch: '', remote: '', actions: [] } });
  const call = (name, params) => tools.get(name).execute('test', params, undefined, undefined, ctx);
  const authenticate = () => call('owner_goal_request', { action: 'Ship', exceptions: ['Bounded delegation'], hours: '6', contract: JSON.stringify(contract()) });
  return { ctx, runtime, hooks, commands, messages, entries, call, authenticate, contract, night,
    state: () => state, grant: () => grant, revocations: () => revocations, requests: () => requests };
}

test('night-edits creates the native goal and shares lifecycle without a second continuation driver', async () => {
  const h = setup();
  await h.commands.get('night-edits').handler('Ship it', h.ctx);
  expect(h.state().goal.objective).toBe('Ship it');
  await h.authenticate();
  const count = h.messages.length;
  await h.night.end(h.ctx);
  expect(h.messages).toHaveLength(count);
  await h.runtime.pauseGoal();
  expect(h.grant()).toBeUndefined();
  expect(h.state().goal.status).toBe('paused');
  await h.runtime.resumeGoal();
  expect(h.requests()).toBe(1);
  expect(h.grant()).toBeUndefined();
});

test('both completion entrypoints require acceptance and complete the same native goal', async () => {
  const h = setup();
  await h.runtime.createGoal({ objective: 'Ship' });
  await h.authenticate();
  await expect(h.runtime.completeGoalFromTool()).rejects.toThrow('Acceptance');
  expect(h.state().goal.status).toBe('active');
  await h.call('owner_goal_progress', { data: JSON.stringify({ operation: 'update', index: 0, status: 'verified', evidence: ['native:test'] }) });
  await h.call('owner_goal_progress', { data: JSON.stringify({ operation: 'complete' }) });
  expect(h.state().goal.status).toBe('complete');
  expect(h.grant()).toBeUndefined();
});

test('grant identity mismatch is refused before authentication', async () => {
  const h = setup();
  await h.runtime.createGoal({ objective: 'Ship' });
  await expect(h.call('owner_goal_request', { action: 'Ship', exceptions: ['Goal'], hours: '6', contract: JSON.stringify({ ...h.contract(), goal_id: 'other' }) })).rejects.toThrow('goal_id');
  expect(h.requests()).toBe(0);
});

test('actual Astra dispatch checks effort, tariff and current capability rather than role name', async () => {
  const h = setup();
  await h.runtime.createGoal({ objective: 'Ship' });
  await h.authenticate();
  const result = await h.hooks.get('before_subagent_spawn')({ agent: 'task', patterns: ['openai-codex/gpt-6-astra:high'] }, h.ctx);
  expect(result.block).not.toBe(true);
  const model = { provider: 'openai-codex', id: 'gpt-6-astra' };
  await result.assertDispatch(model, { reasoning: 'high' });
  await expect(result.assertDispatch(model, { reasoning: 'high', serviceTier: 'priority' })).rejects.toThrow('tier');
  await expect(result.assertDispatch(model, { reasoning: 'xhigh' })).rejects.toThrow('model');
  await h.runtime.pauseGoal();
  await expect(result.assertDispatch(model, { reasoning: 'high' })).rejects.toThrow();
});

test('checkpoint does not revoke and replacement cannot reuse the previous grant', async () => {
  const h = setup();
  await h.runtime.createGoal({ objective: 'Ship' });
  await h.authenticate();
  await h.call('owner_goal_progress', { data: '{"operation":"checkpoint"}' });
  expect(h.grant()).toBeDefined();
  await h.runtime.replaceGoal({ objective: 'Different' });
  expect(h.grant()).toBeUndefined();
  await expect(h.runtime.completeGoalFromTool()).rejects.toThrow();
});

test('interruption revokes the grant before a resume can reuse it', async () => {
  const h = setup();
  await h.runtime.createGoal({ objective: 'Ship' });
  await h.authenticate();
  await h.runtime.onTaskAborted({ reason: 'interrupted' });
  expect(h.grant()).toBeUndefined();
  await h.runtime.resumeGoal();
  await expect(h.runtime.completeGoalFromTool()).rejects.toThrow('No active authenticated');
});

test('a changed contract cannot inherit verified acceptance from a prior scope', async () => {
  const h = setup();
  await h.runtime.createGoal({ objective: 'Ship' });
  await h.authenticate();
  await h.call('owner_goal_progress', { data: JSON.stringify({ operation: 'update', index: 0, status: 'verified', evidence: ['old:test'] }) });
  await h.runtime.pauseGoal();
  await h.runtime.resumeGoal();
  await h.call('owner_goal_request', { action: 'Ship', exceptions: ['Goal'], hours: '6',
    contract: JSON.stringify({ ...h.contract(), operations: ['edit', 'test'] }) });
  await expect(h.runtime.completeGoalFromTool()).rejects.toThrow('Acceptance');
});

test('completion waits for native asynchronous work as well as resource jobs', async () => {
  const h = setup();
  await h.runtime.createGoal({ objective: 'Ship' });
  await h.authenticate();
  await h.call('owner_goal_progress', { data: JSON.stringify({ operation: 'update', index: 0, status: 'verified', evidence: ['native:test'] }) });
  h.ctx.getAsyncJobSnapshot = () => ({ running: [{ id: 'worker' }] });
  await expect(h.runtime.completeGoalFromTool()).rejects.toThrow('resources still running');
  h.ctx.getAsyncJobSnapshot = () => ({ running: [] });
  await h.runtime.completeGoalFromTool();
  expect(h.state().goal.status).toBe('complete');
});
