import { beforeAll, describe, expect, it } from "bun:test";
import { getKeybindings, type TUI } from "@oh-my-pi/pi-tui";
import type { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { ReviewerOverlay } from "../src/overlays/reviewer-overlay";
import type { ReviewerSnapshot } from "../src/overlays/reviewer-types";
import type { ReviewDiffFile } from "../src/overlays/annotation-types";
import type { NativeNode } from "../src/native/node";
import { reviewerSourceSpans } from "../src/overlays/reviewer-highlight";

const longLine = 'const message = "' + "long source ".repeat(35) + 'END_OF_SOURCE";';
function file(path: string, lines: string[]): ReviewDiffFile {
	return {
		path,
		occurrence: 1,
		rawDiff: `diff --git a/${path} b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join("\n")}`,
		rows: lines.map((content, index) => ({
			kind: "added",
			raw: `+${content}`,
			content,
			newLine: index + 1,
			hunkHeader: `@@ -0,0 +1,${lines.length} @@`,
		})),
		linesAdded: lines.length,
		linesRemoved: 0,
		isBinary: false,
	};
}
function nodes(root: NativeNode): NativeNode[] {
	return [root, ...(root.c ?? []).flatMap(child => ("k" in child ? nodes(child as NativeNode) : []))];
}
function find(root: NativeNode, key: string) {
	return nodes(root).find(value => value.key === key);
}
const snapshot: ReviewerSnapshot = {
	root: "/fixture",
	branch: "task",
	ref: "dev",
	base: "a",
	head: "b",
	files: [
		file("Component.vue", [
			'<script setup lang="ts">',
			longLine,
			"</script>",
			"<template><p>{{ message }}</p></template>",
		]),
		file("app.test.ts", ["const testValue = 1;"]),
	],
};
function overlay(load = async () => snapshot, onPaste = (_text: string) => {}) {
	return new ReviewerOverlay(
		{ terminal: { rows: 40 }, requestRender() {} } as unknown as TUI,
		theme,
		getKeybindings() as KeybindingsManager,
		{ snapshot, load, onPaste, onClose() {} },
	);
}
beforeAll(async () => {
	await initTheme(false);
});

describe("reviewer readability", () => {
	it("starts on the whole filtered diff and never crosses comparison boundaries", async () => {
		const view = overlay(async () => ({ ...snapshot, files: [file("uncommitted.ts", ["const unstaged = true;"])] }));
		let tree = view.describe();
		expect(find(tree, "files")?.c?.[0]).toMatchObject({ key: "all" });
		expect(find(tree, "files")?.p).toMatchObject({ selected: "all" });
		expect(
			nodes(tree)
				.filter(value => value.k === "section")
				.map(value =>
					typeof value.p?.head === "string" ? value.p.head : value.p?.head?.map(span => span.t).join(""),
				),
		).toEqual(["Component.vue"]);
		view.handleInput("t");
		expect(nodes(view.describe()).filter(value => value.k === "section")).toHaveLength(2);
		view.handleInput("t");
		expect(
			nodes(view.describe())
				.filter(value => value.k === "section")
				.map(value =>
					typeof value.p?.head === "string" ? value.p.head : value.p?.head?.map(span => span.t).join(""),
				),
		).toEqual(["app.test.ts"]);
		view.handleInput("t");
		view.handleInput("2");
		await Promise.resolve();
		await Promise.resolve();
		tree = view.describe();
		expect(JSON.stringify(tree)).toContain("uncommitted.ts");
		expect(JSON.stringify(tree)).not.toContain("Component.vue");
	});
	it("wraps complete Vue source with real syntax tokens and preserves annotation identity", () => {
		let feedback = "";
		const view = overlay(undefined, text => {
			feedback = text;
		});
		view.describe();
		view.handleNativeEvent({ type: "select", key: "files", item: "f0" });
		const tree = view.describe();
		const line = find(tree, "l1")!;
		expect(line.k).toBe("row");
		const source = nodes(line).find(value => value.k === "text" && value.p?.wrap === "char");
		expect(source).toBeDefined();
		if (source?.k !== "text") throw new Error("Missing wrapped source");
		const spans = source.p?.spans ?? [];
		expect(spans.map(value => value.t).join("")).toBe(longLine);
		expect(spans.some(value => value.s?.includes("syntaxKeyword"))).toBe(true);
		expect(spans.some(value => value.s?.includes("syntaxString"))).toBe(true);
		view.handleNativeEvent({ type: "action", key: "lines/l1", act: "select-line", mods: [] });
		view.handleInput("a");
		view.handleInput("review long line");
		view.handleInput("\r");
		view.handleNativeEvent({ type: "action", key: "paste-all", act: "paste-all", mods: [] });
		expect(feedback).toContain('"Component.vue"');
		expect(feedback).toContain("-/2; source");
		expect(feedback).toContain("END_OF_SOURCE");
		expect(feedback).toContain("review long line");
	});
	it("scrolls the aggregate with existing paging keys and returns to it from the file rail", () => {
		const view = overlay();
		view.describe();
		view.handleInput("\r");
		view.handleInput("\x1b[6~");
		expect(find(view.describe(), "file0")?.scroll).toMatchObject({ by: "page-down", n: 1 });
		view.handleInput("h");
		view.handleInput("j");
		expect(find(view.describe(), "files")?.p).toMatchObject({ selected: "f0" });
		view.handleInput("k");
		expect(find(view.describe(), "files")?.p).toMatchObject({ selected: "all" });
	});
	it.each([
		["frontend.ts", ["export const amount: number = 42;"], "syntaxKeyword"],
		["frontend.js", ["export function total(a, b) { return a + b; }"], "syntaxKeyword"],
		[
			"tailwind.css",
			['@import "tailwindcss";', ".button { @apply flex items-center gap-2; color: red; }"],
			"syntaxString",
		],
		[
			"Frontend.vue",
			[
				'<script setup lang="ts">',
				"const amount: number = 42;",
				"</script>",
				'<template><p class="flex items-center gap-2 hover:text-blue-500">{{ amount }}</p></template>',
				"<style scoped>",
				".button { @apply flex gap-2; }",
				"</style>",
			],
			"syntaxKeyword",
		],
	] as const)("highlights %s without changing frontend source", (path, lines, token) => {
		const source = file(path, [...lines]);
		const highlighted = reviewerSourceSpans(source);
		const spans = [...highlighted.values()].flat();
		expect(spans.some(value => value.s?.includes(token))).toBe(true);
		for (const row of source.rows) {
			if (row.kind !== "added") continue;
			expect(
				highlighted
					.get(row)
					?.map(value => value.t)
					.join(""),
			).toBe(row.content);
		}
	});
	it("renders the same contextual syntax and wrapping in Whole diff and individual files", () => {
		const source = file("Component.vue", ["const value = 42;"]);
		const row = source.rows[0]!;
		if (row.kind !== "added") throw new Error("Expected added source");
		row.newLine = 12;
		source.sources = { new: ['<script setup lang="ts">', ...Array(10).fill(""), row.content, "</script>"] };
		const contextual = new ReviewerOverlay(
			{ terminal: { rows: 40 }, requestRender() {} } as unknown as TUI,
			theme,
			getKeybindings() as KeybindingsManager,
			{ snapshot: { ...snapshot, files: [source] }, load: async () => snapshot, onPaste() {}, onClose() {} },
		);
		const aggregate = find(contextual.describe(), "l0")!;
		contextual.handleNativeEvent({ type: "select", key: "files", item: "f0" });
		const individual = find(contextual.describe(), "l0")!;
		expect(aggregate.c).toEqual(individual.c);
		expect(JSON.stringify(aggregate)).toContain("syntaxKeyword");
		expect(aggregate.p?.actions).toBeUndefined();
		expect(individual.p?.actions).toBeDefined();
	});
	it.each([
		["Component.vue", ['<script setup lang="ts">', "", "const value = 42;", "</script>"], "syntaxKeyword"],
		["Template.vue", ["<template>", "", '<p class="flex gap-2">{{ value }}</p>', "</template>"], "syntaxString"],
		["Style.vue", ["<style scoped>", "", '.button { @apply flex; content: "hello"; }', "</style>"], "syntaxString"],
		["frontend.ts", ["/* outside hunk", "", "const value = 42;", "*/"], "syntaxComment"],
		["frontend.js", ["const message = `outside hunk", "", "const value = 42;", "`;"], "syntaxString"],
	] as const)("retains hidden lexical context in %s", (path, fullSource, token) => {
		const source = file(path, [fullSource[2]]);
		const row = source.rows[0]!;
		if (row.kind !== "added") throw new Error("Expected added source");
		row.newLine = 3;
		source.sources = { new: [...fullSource] };
		const spans = reviewerSourceSpans(source).get(row)!;
		expect(spans.map(value => value.t).join("")).toBe(fullSource[2]);
		expect(spans.some(value => value.s?.includes(token))).toBe(true);
	});
	it("uses independent full old and new Vue contexts for removed and added lines", () => {
		const source = file("Component.vue", ["const value = 42;"]);
		const added = source.rows[0]!;
		if (added.kind !== "added") throw new Error("Expected added source");
		added.newLine = 3;
		const removed = {
			kind: "removed" as const,
			raw: "-const value = 1;",
			content: "const value = 1;",
			oldLine: 3,
			hunkHeader: "@@ -3 +3 @@",
		};
		source.rows.unshift(removed);
		source.sources = {
			old: ['<script setup lang="ts">', "/*", removed.content, "*/", "</script>"],
			new: ['<script setup lang="ts">', "", added.content, "</script>"],
		};
		const highlighted = reviewerSourceSpans(source);
		expect(highlighted.get(removed)?.some(value => value.s?.includes("syntaxComment"))).toBe(true);
		expect(highlighted.get(added)?.some(value => value.s?.includes("syntaxKeyword"))).toBe(true);
	});
	it("never substitutes a different snapshot line for the displayed diff", () => {
		const source = file("frontend.ts", ["const displayed = 42;"]);
		source.sources = { new: ['const other = "snapshot mismatch";'] };
		const row = source.rows[0]!;
		if (row.kind !== "added") throw new Error("Expected added source");
		const spans = reviewerSourceSpans(source).get(row)!;
		expect(spans.map(value => value.t).join("")).toBe(row.content);
		expect(spans.every(value => value.s === "mono")).toBe(true);
	});
	it("does not let a removed open comment swallow added TypeScript", () => {
		const source = file("frontend.ts", ["const value = 42;"]);
		source.rows.unshift({ kind: "removed", raw: "-/*", content: "/*", oldLine: 1, hunkHeader: "@@ -1 +1 @@" });
		const highlighted = reviewerSourceSpans(source);
		const added = source.rows[1]!;
		if (added.kind !== "added") throw new Error("Expected added source");
		expect(highlighted.get(added)?.some(value => value.s?.includes("syntaxKeyword"))).toBe(true);
	});
});
