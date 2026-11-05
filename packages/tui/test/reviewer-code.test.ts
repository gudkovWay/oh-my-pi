import { beforeAll, describe, expect, it } from "bun:test";
import { getKeybindings, type TUI } from "@oh-my-pi/pi-tui";
import type { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { ReviewerOverlay } from "../src/overlays/reviewer-overlay";
import { reviewerSymbols } from "../src/overlays/reviewer-code";
import type { ReviewerCodeService, ReviewerCodeSource, ReviewerSnapshot } from "../src/overlays/reviewer-types";

const source: ReviewerCodeSource = {
	path: "/fixture/app.ts",
	line: 1,
	lines: ["const result = sum(sum(1, 2), 3);"],
	fileHash: "original",
};
const snapshot: ReviewerSnapshot = {
	root: "/fixture",
	branch: "task",
	ref: "main",
	base: "aaa",
	head: "bbb",
	fileHashes: { "app.ts": "original" },
	files: [
		{
			path: "app.ts",
			occurrence: 1,
			rawDiff: "",
			linesAdded: 1,
			linesRemoved: 0,
			isBinary: false,
			rows: [
				{
					kind: "added",
					content: source.lines[0]!,
					raw: `+${source.lines[0]}`,
					newLine: 1,
					hunkHeader: "@@ -0,0 +1 @@",
				},
			],
		},
	],
};
function view(service: ReviewerCodeService, onPaste = (_value: string) => {}) {
	const panel = new ReviewerOverlay(
		{ terminal: { rows: 40 }, requestRender() {} } as unknown as TUI,
		theme,
		getKeybindings() as KeybindingsManager,
		{ snapshot, load: async () => snapshot, onPaste, onClose() {}, code: () => service },
	);
	panel.handleNativeEvent({ type: "select", key: "files", item: "f0" });
	return panel;
}
async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}
const service: ReviewerCodeService = {
	open: async () => source,
	query: async () => ({ text: "(a: number, b: number) => number", locations: [] }),
	read: async () => ({
		...source,
		path: "/fixture/math.ts",
		lines: ["export function sum(a: number, b: number) { return a + b; }"],
	}),
};
beforeAll(async () => {
	await initTheme(false);
});

describe("reviewer semantic inspection", () => {
	it("keeps repeated names and Unicode columns distinct", () => {
		expect(reviewerSymbols("😀 сум(сум)")).toEqual([
			{ name: "сум", character: 3 },
			{ name: "сум", character: 7 },
		]);
	});
	it("selects the exact repeated identifier and sends its UTF-16 position, not the first token", async () => {
		let position = -1;
		const panel = view({
			...service,
			query: async (_source, character) => {
				position = character;
				return { text: "selected inner sum", locations: [] };
			},
		});
		panel.handleInput("s");
		await settle();
		expect(JSON.stringify(panel.describe())).toContain("Inspect symbol");
		panel.handleNativeEvent({ type: "select", key: "symbols", item: "s3" });
		panel.handleInput("h");
		await settle();
		expect(position).toBe(19);
		expect(JSON.stringify(panel.describe())).toContain("selected inner sum");
	});
	it("pages through symbol occurrences with terminal PageDown and PageUp keys", async () => {
		const line = Array.from({ length: 24 }, (_, index) => `symbol${index}`).join(" ");
		const positions: number[] = [];
		const panel = view({
			...service,
			open: async () => ({ ...source, lines: [line] }),
			query: async (_source, character) => {
				positions.push(character);
				return { text: "selected", locations: [] };
			},
		});
		panel.handleInput("s");
		await settle();
		panel.handleInput("\x1b[6~");
		panel.handleInput("h");
		await settle();
		panel.handleInput("\x1b");
		panel.handleInput("\x1b[5~");
		panel.handleInput("h");
		await settle();
		expect(positions).toEqual([line.indexOf("symbol10"), 0]);
	});
	it("previews a definition and returns through results to the diff without losing notes", async () => {
		let pasted = "";
		const panel = view(
			{
				...service,
				query: async () => ({ text: "", locations: [{ path: "/fixture/math.ts", line: 1, character: 16 }] }),
			},
			value => {
				pasted = value;
			},
		);
		panel.describe();
		panel.handleInput("A");
		panel.handleInput("keep this note");
		panel.handleInput("\r");
		panel.handleInput("s");
		await settle();
		panel.handleInput("d");
		await settle();
		expect(JSON.stringify(panel.describe())).toContain("/fixture/math.ts");
		panel.handleInput("\r");
		await settle();
		expect(JSON.stringify(panel.describe())).toContain("export function sum");
		panel.handleInput("\x1b");
		panel.handleInput("\x1b");
		panel.handleInput("\x1b");
		expect(JSON.stringify(panel.describe())).toContain("keep this note");
		panel.handleNativeEvent({ type: "action", key: "paste-all", act: "paste-all", mods: [] });
		expect(pasted).toContain("keep this note");
	});
	it("cancels pending inspection on back and never paints a late result over the diff", async () => {
		const pending = Promise.withResolvers<ReviewerCodeSource>();
		let signal: AbortSignal | undefined;
		const panel = view({
			...service,
			open: async (_file, _row, currentSignal) => {
				signal = currentSignal;
				return pending.promise;
			},
		});
		panel.handleInput("s");
		expect(JSON.stringify(panel.describe())).toContain("Opening source");
		panel.handleInput("\x1b");
		expect(signal?.aborted).toBe(true);
		pending.resolve(source);
		await settle();
		expect(JSON.stringify(panel.describe())).toContain("compared with");
	});
	it("shows stale/unsupported errors and allows returning to the unchanged diff", async () => {
		const panel = view({
			...service,
			open: async () => {
				throw new Error("Snapshot is stale. Refresh the diff.");
			},
		});
		panel.handleInput("s");
		await settle();
		expect(JSON.stringify(panel.describe())).toContain("Snapshot is stale");
		panel.handleInput("\x1b");
		expect(JSON.stringify(panel.describe())).toContain("compared with");
	});
	it("does not steal symbol shortcuts or native inspection while a note is being edited", async () => {
		let pasted = "";
		const panel = view(service, value => {
			pasted = value;
		});
		panel.describe();
		panel.handleInput("A");
		panel.handleInput("s");
		panel.handleNativeEvent({ type: "action", key: "inspect", act: "inspect", mods: [] });
		await settle();
		expect(JSON.stringify(panel.describe())).toContain("compared with");
		panel.handleInput("\r");
		panel.handleNativeEvent({ type: "action", key: "paste-all", act: "paste-all", mods: [] });
		expect(pasted).toContain(": s");
	});
});
