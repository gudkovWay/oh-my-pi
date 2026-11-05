import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings, resetSettingsForTest } from "../../../src/config/settings";
import { EventController } from "../../../src/modes/controllers/event-controller";
import type { AgentSessionEvent } from "../../../src/session/agent-session";
import { validateWorktrunkSelection } from "../../../src/session/worktrunk-selection";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

let holder: string;
let root: string;
let target: string;
let output: string;
const branch = "DEV-capitalism-slave-reviewer-fixture";
async function run(cwd: string, ...args: string[]): Promise<string> {
	const process = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (code !== 0) throw new Error(`${args.join(" ")}: ${stderr}`);
	return stdout;
}
const command = `wt switch --create ${branch} --base dev --format json`;
const end = { type: "agent_end", messages: [] } as unknown as AgentSessionEvent;

beforeAll(async () => {
	await initTheme(false);
	holder = await mkdtemp(join(tmpdir(), "omp-reviewer-worktrunk-"));
	root = join(holder, "repo");
	await mkdir(root);
	await run(root, "git", "init", "-b", "dev");
	await run(
		root,
		"git",
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"--allow-empty",
		"-m",
		"initial",
	);
	output = await run(root, "wt", "switch", "--create", branch, "--base", "dev", "--format", "json");
	target = JSON.parse(
		output
			.trim()
			.split("\n")
			.find(line => line.startsWith("{"))!,
	).path;
});
afterAll(async () => {
	if (holder) await rm(holder, { recursive: true, force: true });
});
beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

async function tool(controller: EventController, result = output, isError = false): Promise<void> {
	await controller.handleEvent({
		type: "tool_execution_start",
		toolCallId: "wt",
		toolName: "bash",
		args: { command },
	} as AgentSessionEvent);
	await controller.handleEvent({
		type: "tool_execution_end",
		toolCallId: "wt",
		toolName: "bash",
		isError,
		result: { content: [{ type: "text", text: result }] },
	} as AgentSessionEvent);
}

describe("Worktrunk automatic session relocation", () => {
	it("validates the real linked checkout and rejects the main checkout or a mismatched branch", async () => {
		expect(await validateWorktrunkSelection(root, { path: target, branch })).toBe(target);
		await expect(validateWorktrunkSelection(root, { path: root, branch: "dev" })).rejects.toThrow("linked worktree");
		await expect(validateWorktrunkSelection(root, { path: target, branch: "dev" })).rejects.toThrow("does not match");
	});
	it("moves only after the owning turn settles, using the existing move command", async () => {
		const state = { streaming: true };
		const move = vi.fn(async () => {});
		const ctx = createInteractiveModeContext({
			session: {
				get isStreaming() {
					return state.streaming;
				},
			},
			sessionManager: { getCwd: () => root, getSessionId: () => "owner" },
			handleMoveCommand: move,
		});
		const controller = new EventController(ctx);
		try {
			await tool(controller);
			expect(move).not.toHaveBeenCalled();
			await controller.handleEvent(end);
			expect(move).not.toHaveBeenCalled();
			state.streaming = false;
			await controller.handleEvent(end);
			expect(move).toHaveBeenCalledTimes(1);
			expect(move).toHaveBeenCalledWith(target);
		} finally {
			controller.dispose();
		}
	});
	it("does not move a replacement session or adopt a failed tool result", async () => {
		let sessionId = "owner";
		const move = vi.fn(async () => {});
		const ctx = createInteractiveModeContext({
			sessionManager: { getCwd: () => root, getSessionId: () => sessionId },
			handleMoveCommand: move,
		});
		const controller = new EventController(ctx);
		try {
			await tool(controller);
			sessionId = "replacement";
			await controller.handleEvent(end);
			expect(move).not.toHaveBeenCalled();
			await tool(controller, output, true);
			await controller.handleEvent(end);
			expect(move).not.toHaveBeenCalled();
		} finally {
			controller.dispose();
		}
	});
});
