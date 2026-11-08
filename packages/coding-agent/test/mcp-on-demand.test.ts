import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let directory: string;
let manager: MCPManager;
const context = {} as CustomToolContext;
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-on-demand-"));
	manager = new MCPManager(directory);
});
afterEach(async () => {
	await manager.disconnectAll();
	await removeWithRetries(directory);
});
function config(name: string): MCPStdioServerConfig {
	return {
		type: "stdio",
		command: process.execPath,
		args: [path.join(import.meta.dir, "fixtures/readiness-mcp.ts")],
		env: { SRV_NAME: name, STARTUP_MARKER: path.join(directory, name) },
		onDemand: true,
	};
}

describe("MCP on-demand connections", () => {
	it("keeps startup processes, credentials, tools and readiness dormant until requested", async () => {
		const result = await manager.connectServers({ alpha: config("alpha"), beta: config("beta") }, {}, undefined, 0);
		expect(result.errors.size).toBe(0);
		expect(result.tools.map(tool => tool.name)).toEqual(["mcp__alpha_connect", "mcp__beta_connect"]);
		expect(manager.getConnectedServers()).toEqual([]);
		expect(await fs.readdir(directory)).toEqual([]);
		expect((await manager.waitForStartup(100)).pending).toEqual([]);
		expect((await manager.waitForStartup(100)).failed).toEqual([]);

		const activation = result.tools[0]!;
		await activation.execute("activate", {}, undefined, context);
		expect(await fs.readFile(path.join(directory, "alpha"), "utf8")).toBe("started");
		expect(await Bun.file(path.join(directory, "beta")).exists()).toBe(false);
		expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__alpha_marker", "mcp__beta_connect"]);
		const tool = manager.getTools().find(tool => tool.name === "mcp__alpha_marker")!;
		const called = await tool.execute("call", {}, undefined, context);
		expect(called.isError).not.toBe(true);
		expect(called.content).toEqual([{ type: "text", text: "MARKER_OK::alpha" }]);
	});

	it("does not resolve shell-backed env values while merely registering a server", async () => {
		const configured = config("alpha");
		configured.env = { ...configured.env, TOKEN: `!printf resolved > '${directory}/credential-read'` };
		const result = await manager.connectServers({ alpha: configured }, {}, undefined, 0);
		expect(await Bun.file(path.join(directory, "credential-read")).exists()).toBe(false);
		await result.tools[0]!.execute("activate", {}, undefined, context);
		expect(await fs.readFile(path.join(directory, "credential-read"), "utf8")).toBe("resolved");
	});

	it("invalidates a saved activation handle when the server is disconnected", async () => {
		const result = await manager.connectServers({ alpha: config("alpha") }, {}, undefined, 0);
		const activation = result.tools[0]!;
		await manager.disconnectServer("alpha");
		await expect(activation.execute("stale", {}, undefined, context)).rejects.toThrow("no longer available");
		expect(await fs.readdir(directory)).toEqual([]);
		expect(manager.getTools()).toEqual([]);
	});

	it("shares one explicit activation and preserves eager servers", async () => {
		const eager = { ...config("eager"), onDemand: false };
		const loaded = await manager.connectServers({ alpha: config("alpha"), eager }, {}, undefined, 0);
		const activation = loaded.tools.find(tool => tool.name === "mcp__alpha_connect")!;
		await Promise.all([
			activation.execute("one", {}, undefined, context),
			activation.execute("two", {}, undefined, context),
		]);
		expect(manager.getConnectedServers().sort()).toEqual(["alpha", "eager"]);
		expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__alpha_marker", "mcp__eager_marker"]);
	});

	it("rejects invalid deferred definitions before exposing an activation tool", async () => {
		const result = await manager.connectServers({ alpha: { ...config("alpha"), command: "" } }, {}, undefined, 0);
		expect(result.errors.has("alpha")).toBe(true);
		expect(result.tools).toEqual([]);
		expect(await fs.readdir(directory)).toEqual([]);
	});
});

it("reports an explicit connection failure without claiming activation succeeded", async () => {
	const invalid = { ...config("alpha"), command: path.join(directory, "missing-server") };
	const loaded = await manager.connectServers({ alpha: invalid }, {}, undefined, 0);
	await expect(loaded.tools[0]!.execute("activate", {}, undefined, context)).rejects.toThrow();
	expect(manager.getConnectedServers()).toEqual([]);
});

it("does not start a transport for an already-cancelled activation", async () => {
	const loaded = await manager.connectServers({ alpha: config("alpha") }, {}, undefined, 0);
	const abort = new AbortController();
	abort.abort();
	await expect(loaded.tools[0]!.execute("activate", {}, undefined, context, abort.signal)).rejects.toThrow();
	expect(await fs.readdir(directory)).toEqual([]);
});
