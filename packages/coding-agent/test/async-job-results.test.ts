import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../src/async/job-manager";
import { createJobResultStore, readJobResult } from "../src/async/job-results";
import { Settings } from "../src/config/settings";
import { InternalUrlRouter } from "../src/internal-urls/router";
import { SessionManager } from "../src/session/session-manager";
import type { ToolSession } from "../src/tools";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { ModelRegistry } from "../src/config/model-registry";
import { convertToLlm } from "../src/session/messages";

const settings = Settings.isolated({ "launch.enabled": false });

test("evicted results survive journal reopen without relaunching or redelivering work", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-job-receipt-"));
	const journal = SessionManager.create(root, path.join(root, "sessions"));
	let launches = 0,
		deliveries = 0;
	const manager = new AsyncJobManager({
		retentionMs: 0,
		resultStore: createJobResultStore(journal),
		onJobComplete: () => {
			deliveries++;
		},
	});
	try {
		const id = manager.register("bash", "one workload", async () => {
			launches++;
			return "exact result";
		});
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 1000 });
		expect(manager.getJob(id)).toBeUndefined();
		await journal.ensureOnDisk();
		await journal.flush();
		const reopened = await SessionManager.open(journal.getSessionFile()!);
		expect(readJobResult(reopened, id, undefined)?.resultText).toBe("exact result");
		expect(readJobResult(reopened, id, "AnotherAgent")).toBeUndefined();
		expect(readJobResult(reopened, "wrong-id", undefined)).toBeUndefined();
		const session = {
			cwd: root,
			settings,
			sessionManager: reopened,
			asyncJobManager: manager,
			getSessionFile: () => reopened.getSessionFile(),
			getSessionSpawns: () => "*",
			hasUI: false,
		} as ToolSession;
		const resolved = await InternalUrlRouter.instance().resolve(`proc://${id}`, { session });
		expect(resolved.content).toContain("exact result");
		expect(resolved.content).toContain("retained receipt");
		const restarted = new AsyncJobManager({ resultStore: createJobResultStore(reopened), retentionMs: 0 });
		const next = restarted.register("bash", "next workload", async () => "next");
		expect(next).not.toBe(id);
		await restarted.waitForAll();
		await restarted.dispose();
		expect(launches).toBe(1);
		expect(deliveries).toBe(1);
	} finally {
		await manager.dispose();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("dead-lettered failures keep their original owner and diagnostic after eviction", async () => {
	const journal = SessionManager.inMemory();
	const manager = new AsyncJobManager({ retentionMs: 0, resultStore: createJobResultStore(journal) });
	const id = manager.register(
		"task",
		"failed task",
		async () => {
			throw new Error("original failure");
		},
		{ id: "Worker", ownerId: "Main" },
	);
	await manager.waitForAll();
	expect(readJobResult(journal, id, "Main")?.errorText).toBe("original failure");
	expect(readJobResult(journal, id, "Child")).toBeUndefined();
	const next = manager.register("task", "another task", async () => "next", { id: "Worker", ownerId: "Main" });
	expect(next).toBe("Worker-2");
	await manager.waitForAll();
	await manager.dispose();
});

async function transitionFixture(root: string) {
	const journal = SessionManager.create(root, path.join(root, "sessions"));
	await journal.ensureOnDisk();
	const manager = new AsyncJobManager({ retentionMs: 0, resultStore: createJobResultStore(journal) });
	const auth = await AuthStorage.create(":memory:");
	const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
	const agent = new Agent({
		getApiKey: () => "fixture",
		streamFn: mock.stream,
		convertToLlm,
		initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, tools: [], systemPrompt: ["Fixture"] },
	});
	const active = new AgentSession({
		agent,
		sessionManager: journal,
		settings,
		modelRegistry: new ModelRegistry(auth),
		agentId: "Main",
		ownedAsyncJobManager: manager,
	});
	return { journal, manager, active, auth };
}

for (const transition of ["new", "switch"] as const) {
	test(`late cancellation after real ${transition} persists only in the originating journal`, async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-job-transition-"));
		const { journal, manager, active, auth } = await transitionFixture(root);
		const originalFile = journal.getSessionFile()!;
		const gate = Promise.withResolvers<string>();
		const id = manager.register("bash", "delayed cancellation", () => gate.promise, { ownerId: "Main" });
		try {
			if (transition === "new") await active.newSession();
			else {
				const target = SessionManager.create(root, path.join(root, "sessions"));
				await target.ensureOnDisk();
				await target.close();
				await active.switchSession(target.getSessionFile()!);
			}
			expect(journal.getSessionFile()).not.toBe(originalFile);
			gate.resolve("original result after cancellation");
			await manager.waitForAll();
			expect(readJobResult(journal, id, "Main")).toBeUndefined();
			const reopened = await SessionManager.open(originalFile);
			try {
				expect(readJobResult(reopened, id, "Main")).toMatchObject({
					status: "cancelled",
					resultText: "original result after cancellation",
				});
				expect(
					reopened
						.getEntries()
						.filter(entry => entry.type === "custom" && entry.customType === "async-job-result"),
				).toHaveLength(1);
			} finally {
				await reopened.close();
			}
		} finally {
			gate.resolve("cleanup");
			await active.dispose();
			auth.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
}

test("real session resume reserves existing handles before new work registers", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-job-resume-"));
	const { journal, manager, active, auth } = await transitionFixture(root);
	const target = SessionManager.create(root, path.join(root, "sessions"));
	const previous = new AsyncJobManager({ retentionMs: 0, resultStore: createJobResultStore(target) });
	const original = previous.register("bash", "original work", async () => "original output", { ownerId: "Main" });
	await previous.waitForAll();
	await target.close();
	try {
		await active.switchSession(target.getSessionFile()!);
		const next = manager.register("bash", "new work", async () => "new output", { ownerId: "Main" });
		expect(next).not.toBe(original);
		await manager.waitForAll();
		expect(readJobResult(journal, original, "Main")?.resultText).toBe("original output");
	} finally {
		await previous.dispose();
		await active.dispose();
		auth.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("a child with a separate journal recovers from its shared manager without crossing owners", async () => {
	const root = SessionManager.inMemory();
	const child = SessionManager.inMemory();
	const manager = new AsyncJobManager({ retentionMs: 0, resultStore: createJobResultStore(root) });
	const id = manager.register("eval", "child computation", async () => "child output", { ownerId: "Child" });
	await manager.waitForAll();
	const session = {
		cwd: "/tmp",
		settings,
		sessionManager: child,
		asyncJobManager: manager,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => "Child",
		hasUI: false,
	} as ToolSession;
	const resolved = await InternalUrlRouter.instance().resolve(`proc://${id}`, { session });
	expect(resolved.content).toContain("child output");
	expect(manager.readResult(id, "OtherChild")).toBeUndefined();
	await manager.dispose();
});

test("a failed durable write retains the live result instead of silently evicting it", async () => {
	const journal = SessionManager.inMemory();
	let writes = 0;
	const manager = new AsyncJobManager({
		retentionMs: 0,
		resultStore: {
			...createJobResultStore(journal),
			captureWriter: () => async () => {
				writes++;
				throw new Error("fixture disk failure");
			},
		},
	});
	const id = manager.register("bash", "retained failure", async () => "recoverable result");
	await manager.waitForAll();
	expect(manager.getJob(id)?.resultText).toBe("recoverable result");
	expect(manager.getJob(id)?.latestDetails?.resultPersistenceError).toBe("fixture disk failure");
	expect(writes).toBe(1);
	await manager.dispose();
});
