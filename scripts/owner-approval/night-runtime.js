import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const GUARD = '/home/q/.config/worktrunk/projects/guarded-run';
const inside = (path, root) => path === root || path.startsWith(root + '/');
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], details: data });
const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const contractHash = goal => createHash('sha256').update(JSON.stringify(canonical(goal))).digest('hex');


export function registerNightRuntime(api, authority, runtime = {}) {
  const launch = runtime.spawn ?? spawn;
  const timer = runtime.setTimeout ?? setTimeout;
  const clearTimer = runtime.clearTimeout ?? clearTimeout;
  const now = runtime.now ?? Date.now;
  const T = api.typebox.Type;
  const jobs = new Map();
  let progress = [], revision = 0, synchronizing = false;
  let inhibitor, expiryTimer, expiresAt = 0;
  const files = new Set();
  const active = () => authority.active()?.request.purpose === 'goal' ? authority.active() : undefined;
  const snapshot = () => ({ goal: active()?.request.goal, scope_hash: scopeHash(), progress, jobs: [...jobs].map(([id, j]) =>
    ({ id, state: j.state, exit: j.exit, memory: j.memory })), revision });
  const scopeHash = () => active() ? contractHash(active().request.goal) : undefined;
  const notify = text => api.sendMessage({ customType: 'night-goal', content: text, display: true },
    { deliverAs: 'nextTurn', triggerTurn: true });
  const nativeGoal = ctx => {
    if (!ctx.goal) throw new Error('Update OMP: the native goal lifecycle API is required');
    return ctx.goal;
  };
  async function revoke(ctx) {
    synchronizing = true;
    try { await authority.revoke(ctx); } finally { synchronizing = false; }
  }
  const planning = goal => api.sendMessage({ customType: 'goal-planning', display: false, content:
    `Prepare the native goal ${goal.id}: ${goal.objective}. Research first, then record acceptance and an immutable scope. ` +
    'Call owner_goal_request with this exact goal_id before protected execution. The confirmed contract includes delegation ' +
    'on its explicit provider/model:effort selectors (at most high) and tiers. No silent model fallback. ' +
    'Use resource_job and scoped descendant tickets. Keep owner_goal_progress evidence. Checkpoint does not pause. ' +
    'Preserve the current Jev mode; OFF stays OFF.' }, { deliverAs: 'nextTurn', triggerTurn: false });
  function assertComplete(ctx) {
    if (progress.some(p => p.status !== 'verified') || !progress.length ||
        [...jobs.values()].some(j => !j.done) || ctx.getAsyncJobSnapshot?.()?.running.length) {
      throw new Error('Acceptance incomplete or resources still running');
    }
  }
  api.on('goal_transition', async (event, ctx) => {
    if (ctx.agent?.kind === 'sub') return;
    if (event.phase === 'before') {
      if (event.operation === 'complete') {
        const grant = await verified(ctx);
        if (grant.request.goal.goal_id !== event.goal.id) throw new Error('Goal identity changed');
        assertComplete(ctx);
      } else if (['pause', 'drop', 'replace'].includes(event.operation) && active()) {
        api.appendEntry('night-checkpoint', snapshot());
        await revoke(ctx);
      }
    } else if (event.operation === 'complete') {
      await revoke(ctx);
    } else if (['create', 'replace', 'resume'].includes(event.operation)) {
      planning(event.goal);
    }
  });
  async function verified(ctx, signal) {
    const grant = active();
    if (!grant) throw new Error('No active authenticated night goal');
    const state = nativeGoal(ctx).getState();
    if (!state?.enabled || state.goal.id !== grant.request.goal.goal_id) throw new Error('No matching active native goal');
    await authority.verify(grant, ctx, signal);
    if (active() !== grant || !nativeGoal(ctx).getState()?.enabled ||
        nativeGoal(ctx).getState()?.goal.id !== grant.request.goal.goal_id) throw new Error('Goal authority changed during verification');
    return grant;
  }
  function stop() {
    expiresAt = 0;
    clearTimer(expiryTimer);
    inhibitor?.kill('SIGTERM'); inhibitor = undefined;
    for (const job of jobs.values()) if (!job.done) job.child.kill('SIGTERM');
    for (const file of files) { try { unlinkSync(file); } catch {} }
    files.clear();
  }
  function start(grant, seconds, ctx) {
    expiresAt = now() + seconds*1000;
    const saved = (ctx.sessionManager.getBranch?.() ?? []).findLast(entry =>
      entry.type === 'custom' && ['night-progress', 'night-checkpoint'].includes(entry.customType) &&
      entry.data?.goal?.goal_id === grant.request.goal.goal_id && entry.data?.scope_hash === contractHash(grant.request.goal))?.data?.progress;
    progress = grant.request.goal.acceptance.map(criterion =>
      saved?.find(p => p.criterion === criterion) ?? { criterion, status: 'pending', evidence: [] });
    revision = 0;
    // Finite owned sleep inhibitor; does not inhibit screen blanking or touch profiles.
    inhibitor = launch('systemd-inhibit', ['--what=sleep', '--mode=block', '--why=OMP night goal',
      'sleep', String(seconds)], { stdio: 'ignore' });
    inhibitor.on('error', () => {
      inhibitor = undefined;
      notify('Sleep inhibitor failed: the goal is active, but host sleep is not prevented. Preserve a checkpoint.');
    });
    inhibitor.on('exit', code => {
      inhibitor = undefined;
      if (active() && code !== 0) notify('Sleep inhibitor exited: host sleep prevention is unverified.');
    });
    expiryTimer = timer(() => {
      void authority.revoke(ctx).then(() => nativeGoal(ctx).pauseGoal()).catch(() => stop());
    }, seconds*1000);
    expiryTimer.unref?.();
  }
  async function ticket(grant, roots, role, ctx, signal) {
    const token = await authority.transport('issue_descendant', {
      ...authority.capability(grant), roots, role,
    }, ctx, signal);
    const directory = join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, 'omp-goal-tickets');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) {
      throw new Error('Unsafe goal ticket directory');
    }
    const path = join(directory, randomBytes(16).toString('hex') + '.json');
    writeFileSync(path, JSON.stringify({ ...token, session: grant.request.session, cwd: roots[0] }),
      { mode: 0o600, flag: 'wx' });
    files.add(path);
    return path;
  }
  api.on('before_subagent_spawn', async (event, ctx) => {
    if (!active() && !ctx.goal?.getState()?.enabled) return;
    try {
      const grant = await verified(ctx);
      if (!event.patterns?.length || event.patterns.some(model => !grant.request.goal.models.includes(model))) {
        return { block: true, reason: 'Subagent model is outside the authenticated goal; choose an exact approved selector.' };
      }
      return { assertDispatch: async (model, options) => {
        if (active() !== grant) throw new Error('Goal authority revoked');
        await verified(ctx);
        const selector = `${model.provider}/${model.id}:${options?.reasoning ?? 'off'}`;
        if (!grant.request.goal.models.includes(selector)) throw new Error('Resolved subagent model/effort is outside the goal');
        const tier = options?.serviceTier ?? 'default';
        if (!grant.request.goal.tiers.includes(tier)) throw new Error('Resolved service tier is outside the goal');
      } };
    } catch { return { block: true, reason: 'Goal authority unavailable; authenticate before delegating.' }; }
  });
  api.registerCommand('night-edits', {
    description: 'Create a native goal with the same lifecycle and authenticated execution as /goal',
    async handler(args, ctx) {
      if (!args.trim()) { ctx.ui?.notify('Specify outcome and boundaries.', 'error'); return; }
      await nativeGoal(ctx).createGoal({ objective: args });
      api.sendMessage({ customType: 'goal-start', display: false, content: args }, { triggerTurn: true });
    },
  });
  api.registerTool({ name: 'owner_goal_request', label: 'Authenticate night goal', loadMode: 'essential', approval: 'exec',
    description: 'Authenticate the current native /goal or /night-edits goal for 6–8h; validate_only performs no authentication. contract JSON: goal_id (exact native ID),outcome,acceptance,roots,models (exact provider/model:effort selectors, off|minimal|low|medium|high; e.g. openai-codex/gpt-6-astra:high),tiers(default|priority),operations,resources{memory_ceiling,runtime_seconds,elastic,gpu},delivery{branch,remote,actions:[commit|push|mr]}. Delegation is included only on the confirmed models and scopes. ' + authority.scopeHint,
    parameters: T.Object({ ...authority.scopeParameters, hours: T.Union([T.Literal('6'), T.Literal('7'), T.Literal('8')]),
      contract: T.String(), validate_only: T.Optional(T.Boolean()) }),
    async execute(_id, params, signal, _update, ctx) {
      if (!/^[678]$/.test(params.hours)) throw new Error('Choose 6, 7 or 8 hours');
      const goal = JSON.parse(params.contract);
      const validation = await authority.transport('validate', {
        session: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, action: params.action, exceptions: params.exceptions,
        purpose: 'goal', duration_seconds: Number(params.hours)*3600, goal,
      }, ctx, signal);
      if (validation.valid !== true || validation.authorization !== false)
        throw new Error('Invalid approval contract:\n' + (validation.errors ?? ['Local validator unavailable']).join('\n'));
      if (params.validate_only === true) return result({ valid: true, authorization: false, goal_id: goal.goal_id });
      const state = nativeGoal(ctx).getState();
      if (!state?.enabled || goal.goal_id !== state.goal.id) throw new Error('contract.goal_id must match the active native goal');
      if (!goal.models.every(selector => {
        const resolved = ctx.models?.resolve(selector);
        return resolved && selector.startsWith(`${resolved.provider}/${resolved.id}:`);
      })) throw new Error('A goal model is not available as an exact configured selector');
      synchronizing = true;
      let response;
      try {
        response = await authority.request({ action: params.action, exceptions: params.exceptions,
          purpose: 'goal', duration_seconds: Number(params.hours)*3600, goal }, ctx, signal);
      } finally { synchronizing = false; }
      start(active(), response.remaining_seconds, ctx);
      return result({ ...response, goal_id: goal.goal_id, progress });
    },
  });
  api.registerTool({ name: 'owner_goal_progress', label: 'Night goal progress', loadMode: 'essential',
    description: 'Inspect/update acceptance or save a non-revoking checkpoint. data JSON: {operation:status|update|checkpoint|complete|pause,index?,status?:pending|running|verified|blocked,evidence?:string[]}. Use update/checkpoint for recoverable in-scope failures; a blocked criterion does not stop independent work. pause deliberately revokes the goal and requires fresh authentication to resume; never use it merely to save progress. Evidence claims do not substitute for tests or enabled Jev acceptance.',
    parameters: T.Object({ data: T.String() }),
    async execute(_id, params, signal, _update, ctx) {
      await verified(ctx, signal);
      const change = JSON.parse(params.data);
      if (change.operation === 'update') {
        if (!Number.isInteger(change.index) || !progress[change.index] ||
            !['pending', 'running', 'verified', 'blocked'].includes(change.status) ||
            !Array.isArray(change.evidence) || change.evidence.some(e => typeof e !== 'string' || e.length > 2000)) {
          throw new Error('Specify acceptance index, status and bounded evidence references');
        }
        if (change.status === 'verified' && !change.evidence.length) throw new Error('Verification requires evidence');
        progress[change.index] = { ...progress[change.index], status: change.status, evidence: change.evidence };
        revision++;
        api.appendEntry('night-progress', snapshot());
      } else if (change.operation === 'checkpoint') {
        if (change.evidence !== undefined && (!Array.isArray(change.evidence) ||
            change.evidence.some(e => typeof e !== 'string' || e.length > 2000))) {
          throw new Error('Checkpoint evidence must be bounded references');
        }
        api.appendEntry('night-checkpoint', { ...snapshot(), evidence: change.evidence ?? [] });
        return result({ ...snapshot(), checkpoint: true, authority_active: true,
          next_action: 'Continue authorized in-scope work; checkpoint does not pause or renew the grant' });
      } else if (change.operation === 'complete') {
        assertComplete(ctx);
        const completed = snapshot();
        await nativeGoal(ctx).completeGoalFromTool();
        return result({ completed: true, ...completed });
      } else if (change.operation === 'pause') {
        api.appendEntry('night-checkpoint', snapshot());
        await nativeGoal(ctx).pauseGoal();
        return result({ paused: true, authority_active: false,
          next_action: 'Goal capability revoked; fresh system authentication is required to resume protected work' });
      } else if (change.operation !== 'status') throw new Error('Unknown goal progress operation');
      return result(snapshot());
    },
  });
  api.registerTool({ name: 'owner_goal_delegate', label: 'Scoped worker ticket', loadMode: 'essential',
    description: 'Issue a descendant ticket restricted to an approved goal subdirectory. Returns a private ticket FILE PATH, never its secret; do not read or print the file. Pass the path for guarded resource jobs in that slice.',
    parameters: T.Object({ root: T.String() }),
    async execute(_id, params, signal, _update, ctx) {
      const grant = await verified(ctx, signal);
      const root = realpathSync(params.root);
      if (!grant.request.goal.roots.some(r => inside(root, r))) throw new Error('Worker scope outside goal');
      return result({ ticket_file: await ticket(grant, [root], 'worker', ctx, signal), root });
    },
  });
  api.registerTool({ name: 'resource_job', label: 'Supervised resource job', loadMode: 'essential',
    description: 'Goal-only submit/status/wait/cancel. Submit data: {operation,command:string[],cwd,need?:bytes,memory?:bytes,elastic?:bool,ceiling?:bytes,runtime:seconds,exclusive?:bool,gpu_key?:string}. Wait data: {operation:"wait",job_id,timeout?:seconds}; default 60s, maximum remaining lease. Submit once: completion delivers an event with output, so do not repeatedly poll. A wait/RPC timeout never resubmits or cancels the owned job. No visible desktop without scope.',
    parameters: T.Object({ data: T.String() }),
    async execute(_id, params, signal, _update, ctx) {
      const grant = await verified(ctx, signal);
      const data = JSON.parse(params.data);
      if (data.operation !== 'submit') {
        const job = jobs.get(data.job_id);
        if (!['status', 'wait', 'cancel'].includes(data.operation)) throw new Error('Unknown resource operation');
        if (!job || job.grantId !== grant.id) {
          const entries = ctx.sessionManager.getBranch?.() ?? [];
          const saved = entries.findLast(entry => entry.type === 'custom' &&
            entry.customType === 'night-resource-result' && entry.data?.schema === 1 &&
            entry.data.grant_id === grant.id && entry.data.job_id === data.job_id)?.data;
          if (!saved) throw new Error('Unknown owned job');
          return result({ job_id: saved.job_id, state: saved.state, exit: saved.exit, output: saved.output,
            memory: saved.memory, retained: true,
            next_action: 'Retained completed result; no process was started or controlled. Inspect evidence, do not resubmit.' });
        }
        if (data.operation === 'cancel' && !job.done) job.child.kill('SIGTERM');
        else if (data.operation === 'wait' && !job.done) {
          const seconds = data.timeout ?? 60;
          if (!Number.isFinite(seconds) || seconds < 0 || seconds > 28800) throw new Error('Wait timeout must be 0..28800 seconds');
          const deadline = Math.min(seconds*1000, Math.max(0, expiresAt-now()));
          await new Promise((resolve, reject) => {
            let handle, settled = false;
            const cleanup = () => { clearTimer(handle); signal?.removeEventListener('abort', abort); };
            const finish = () => { if (settled) return; settled = true; cleanup(); resolve(); };
            const abort = () => {
              if (settled) return;
              settled = true; cleanup(); reject(signal.reason ?? new Error('Wait aborted; owned job remains active'));
            };
            if (signal?.aborted) { abort(); return; }
            signal?.addEventListener('abort', abort, { once: true });
            handle = timer(finish, deadline);
            job.settled.then(finish);
          });
        }
        return result({ job_id: data.job_id, state: job.state, exit: job.exit, output: job.output,
          next_action: job.done ? 'Inspect exit/output; process exit is not acceptance' : 'Await completion event; do not resubmit' });
      }
      if (!Array.isArray(data.command) || !data.command.length || data.command.some(x => typeof x !== 'string' || x.includes('\0'))) throw new Error('Command must be argv');
      const cwd = realpathSync(data.cwd);
      if (!grant.request.goal.roots.some(r => inside(cwd, r))) throw new Error('Resource cwd outside goal');
      if (data.gpu_key && !grant.request.goal.resources.gpu) throw new Error('GPU runtime not approved');
      if (data.elastic && !grant.request.goal.resources.elastic) throw new Error('Elastic RAM not approved');
      if ([...jobs.values()].filter(job => !job.done).length >= 8) throw new Error('Goal already owns eight outstanding requests; await existing work');
      for (const name of ['need', 'memory', 'ceiling']) if (data[name] !== undefined &&
        (!Number.isSafeInteger(data[name]) || data[name] <= 0 || data[name] > grant.request.goal.resources.memory_ceiling)) {
        throw new Error('Memory request outside goal');
      }
      if (!Number.isInteger(data.runtime) || data.runtime < 1 || data.runtime > grant.request.goal.resources.runtime_seconds) throw new Error('Runtime outside goal');
      const id = randomBytes(16).toString('hex');
      if (typeof api.captureEntryWriter !== 'function') throw new Error('Update the OMP host: origin-bound journal writers are required');
      const persist = api.captureEntryWriter();
      const originSessionId = ctx.sessionManager.getSessionId();
      const file = await ticket(grant, [cwd], 'resource', ctx, signal);
      const runtime = data.runtime;
      if (!Number.isInteger(runtime) || runtime < 1 || runtime > grant.request.goal.resources.runtime_seconds) throw new Error('Runtime outside goal');
      const args = ['--goal-ticket', file, '--job-id', id, '--runtime', String(runtime),
        '--wait', String(grant.request.duration_seconds)];
      for (const key of ['need', 'memory']) if (data[key] !== undefined) {
        if (!Number.isSafeInteger(data[key]) || data[key] <= 0) throw new Error('Invalid memory request');
        args.push('--'+key, String(data[key]));
      }
      if (data.elastic) args.push('--elastic', '--ceiling', String(data.ceiling ?? grant.request.goal.resources.memory_ceiling));
      if (data.exclusive) args.push('--exclusive-key', cwd);
      if (data.gpu_key) args.push('--gpu-key', data.gpu_key);
      args.push('--', ...data.command);
      for (const [key, job] of jobs) if (job.done && job.receiptSaved && jobs.size >= 64) jobs.delete(key);
      const child = launch(GUARD, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let resolve;
      const job = { child, grantId: grant.id, receiptSaved: false, state: 'queued', output: '', exit: null, done: false,
        settled: new Promise(r => { resolve = r; }) };
      jobs.set(id, job);
      const consume = chunk => {
        job.output = (job.output + chunk.toString()).slice(-64000);
        for (const line of chunk.toString().split('\n')) {
          try { const event = JSON.parse(line); if (event.event === 'admitted') job.state = 'running';
            if (event.memory) job.memory = event.memory; } catch {}
        }
      };
      child.stdout.on('data', consume); child.stderr.on('data', consume);
      const finish = async (code, error) => {
        if (job.done) return;
        job.done = true; job.exit = code; job.state = error ? 'failed' : 'finished';
        if (error) job.output += String(error);
        try {
          await persist('night-resource-result', { schema: 1, grant_id: grant.id, goal_id: grant.request.goal.goal_id,
            job_id: id, state: job.state, exit: code, output: job.output, memory: job.memory });
          job.receiptSaved = true;
        } catch (error) {
          job.output += '\nDurable result receipt unavailable: ' + String(error);
        }
        revision++; resolve();
        if (active()?.id === grant.id && ctx.sessionManager.getSessionId() === originSessionId) notify(`Owned resource job ${id} finished with exit ${code}. This is process exit, not acceptance. ` +
          JSON.stringify({ job_id: id, state: job.state, exit: code, output: job.output.slice(-8000) }));
        try { unlinkSync(file); } catch {} files.delete(file);
      };
      child.once('error', error => finish(null, error));
      child.once('close', code => finish(code));
      return result({ job_id: id, state: job.state, next_action: 'Await completion event; do not poll or resubmit' });
    },
  });
  return {
    stop,
    async revoked(ctx) {
      if (!synchronizing && ctx.goal?.getState()?.enabled) await ctx.goal.pauseGoal();
    },
    async end(ctx) {
      if (!active()) return;
      try { await verified(ctx); } catch { await authority.revoke(ctx); return; }
      api.appendEntry('night-checkpoint', snapshot());
      // Native GoalRuntime is the only continuation driver.
    },
    hash: () => createHash('sha256').update(JSON.stringify(snapshot())).digest('hex'),
  };
}
