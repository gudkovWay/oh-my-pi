import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import {
	dispatchXdevTool,
	resolveXdevTool,
	xdevDocs,
	xdevDocsAll,
	xdevListing,
	type XdevState,
} from "@oh-my-pi/pi-coding-agent/tools/xdev";

function state(): XdevState {
	const tools: Tool[] = [
		{
			name: "lsp",
			label: "LSP",
			description: "Native navigation",
			parameters: type({ file: "string" }),
			execute: async () => ({ content: [{ type: "text", text: "native" }] }),
		},
		{
			name: "mcp__archive_inspect",
			label: "archive/inspect",
			mcpServerName: "archive",
			mcpToolName: "inspect",
			description: "Inspect an archive",
			parameters: type({ file: "string" }),
			execute: async () => ({ content: [{ type: "text", text: "inspected" }] }),
		} as Tool,
		{
			name: "mcp__archive_list",
			label: "archive/list",
			mcpServerName: "archive",
			mcpToolName: "list",
			description: "List entries",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text", text: "listed" }] }),
		} as Tool,
	];
	const value: XdevState = {
		tools: new Map(tools.map(tool => [tool.name, tool])),
		mountedNames: new Set(tools.map(tool => tool.name)),
		builtInNames: new Set(["lsp"]),
		isActive: () => false,
		resolve: name => resolveXdevTool(value, name),
	};
	return value;
}

describe("compact on-demand tool index", () => {
	it("groups MCPs without copying their tool catalog or schemas, while lookup and dispatch remain available", async () => {
		const xdev = state();
		const index = xdevDocsAll(xdev, "index");
		expect(index).toContain("archive (2 tools)");
		expect(index).toContain("lsp");
		expect(index).toContain("xd://");
		expect(index).not.toContain("mcp__archive_inspect");
		expect(index).not.toContain("Inspect an archive");
		expect(index).not.toContain("type Args");
		expect(xdevListing(xdev)).toContain("xd://mcp__archive_inspect");
		expect(xdevDocs(xdev, "mcp__archive_inspect")).toContain("file: string");
		const result = await dispatchXdevTool(xdev, "mcp__archive_inspect", '{"file":"input.zip"}', "inspect");
		expect(result.result.content).toEqual([{ type: "text", text: "inspected" }]);
	});

	it("does not repeat mounted device names in Eval's session-tool catalog", () => {
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "",
			settings: Settings.isolated({ "eval.py": false, "eval.js": true }),
			xdev: state(),
			getEvalBridgeToolNames: () => ["read", "lsp", "mcp__archive_inspect"],
		};
		const description = new EvalTool(session).description;
		expect(description).toContain("`read`");
		expect(description).not.toContain("mcp__archive_inspect");
		expect(description).not.toContain("`lsp`");
	});
});
