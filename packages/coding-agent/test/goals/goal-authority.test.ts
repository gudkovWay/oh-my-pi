import { expect, test } from "bun:test";
import { GoalRuntime, type GoalRuntimeHost } from "../../src/goals/runtime";
import type { GoalModeState } from "../../src/goals/state";

function harness() {
	let state: GoalModeState | undefined;
	const transitions: string[] = [];
	let refuseCompletion = true;
	const host: GoalRuntimeHost = {
		getState: () => state,
		setState: value => {
			state = value;
		},
		getCurrentUsage: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		emit: () => {},
		persist: () => {},
		sendHiddenMessage: async () => {},
		transition: async event => {
			transitions.push(`${event.phase}:${event.operation}:${event.goal.id}`);
			if (event.phase === "before" && event.operation === "complete" && refuseCompletion) {
				throw new Error("Acceptance incomplete or resources still running");
			}
		},
	};
	return {
		runtime: new GoalRuntime(host),
		transitions,
		state: () => state,
		allowCompletion: () => {
			refuseCompletion = false;
		},
	};
}

test("completion refuses before changing the native goal and succeeds after acceptance", async () => {
	const h = harness();
	const created = await h.runtime.createGoal({ objective: "Ship verified work" });
	await expect(h.runtime.completeGoalFromTool()).rejects.toThrow("Acceptance incomplete");
	expect(h.state()?.goal.status).toBe("active");
	h.allowCompletion();
	await h.runtime.completeGoalFromTool();
	expect(h.state()?.goal.status).toBe("complete");
	expect(h.transitions).toContain(`after:complete:${created.goal.id}`);
});

test("all lifecycle entrypoints report transitions against the native goal identity", async () => {
	const h = harness();
	const created = await h.runtime.createGoal({ objective: "First" });
	await h.runtime.pauseGoal();
	await h.runtime.resumeGoal();
	const replaced = await h.runtime.replaceGoal({ objective: "Second" });
	await h.runtime.dropGoal();
	expect(replaced.goal.id).not.toBe(created.goal.id);
	for (const op of ["create", "pause", "resume", "replace", "drop"]) {
		expect(h.transitions.some(value => value.startsWith(`before:${op}:`))).toBe(true);
		expect(h.transitions.some(value => value.startsWith(`after:${op}:`))).toBe(true);
	}
	expect(h.state()).toBeUndefined();
});

test("interrupt and restored active goals pass through the same revoking pause transition", async () => {
	const h = harness();
	await h.runtime.createGoal({ objective: "Ship" });
	await h.runtime.onTaskAborted({ reason: "interrupted" });
	expect(h.state()?.goal.status).toBe("paused");
	expect(h.transitions.some(value => value.startsWith("before:pause:"))).toBe(true);
	await h.runtime.resumeGoal();
	const before = h.transitions.length;
	await h.runtime.onThreadResumed();
	expect(h.state()?.goal.status).toBe("paused");
	expect(h.transitions.slice(before).some(value => value.startsWith("after:pause:"))).toBe(true);
});
