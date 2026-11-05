import { beforeAll, describe, expect, it } from "bun:test";
import { getKeybindings, type TUI } from "@oh-my-pi/pi-tui";
import type { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { ReviewerOverlay } from "../src/overlays/reviewer-overlay";
import { filterReviewerFiles, isReviewerTestFile, type ReviewerSnapshot } from "../src/overlays/reviewer-types";
import type { ReviewDiffFile } from "../src/overlays/annotation-types";
import type { NativeNode } from "../src/native/node";

function file(path: string): ReviewDiffFile {
	return {
		path,
		occurrence: 1,
		rawDiff: `diff --git a/${path} b/${path}\n@@ -0,0 +1 @@\n+source`,
		rows: [{ kind: "added", raw: "+source", content: "source", newLine: 1, hunkHeader: "@@ -0,0 +1 @@" }],
		linesAdded: 1,
		linesRemoved: 0,
		isBinary: false,
	};
}
function find(root: NativeNode, key: string): NativeNode | undefined {
	if (root.key === key) return root;
	for (const child of root.c ?? []) {
		if (typeof child === "object" && child !== null && "k" in child) {
			const found = find(child as NativeNode, key);
			if (found) return found;
		}
	}
	return undefined;
}
const snapshot: ReviewerSnapshot = {
	root: "/fixture/task",
	branch: "task",
	ref: "origin/dev",
	base: "aaa",
	head: "bbb",
	files: [file("app.ts"), file("app.test.ts")],
};
beforeAll(async () => {
	await initTheme(false);
});
function overlay(onPaste: (text: string) => void = () => {}, load = async () => snapshot): ReviewerOverlay {
	return new ReviewerOverlay(
		{ terminal: { rows: 40 }, requestRender() {} } as unknown as TUI,
		theme,
		getKeybindings() as KeybindingsManager,
		{ snapshot, load, onPaste, onClose() {} },
	);
}

describe("human reviewer", () => {
	it("only classifies .test files, not fixtures, snapshots or test-like directory names", () => {
		expect(["a.test.ts", "nested/a.test.tsx", "a.test"].map(isReviewerTestFile)).toEqual([true, true, true]);
		expect(
			["tests/a.ts", "a.spec.ts", "a.test-data.ts", "a.snap", "a.test.ts/actual.ts"].map(isReviewerTestFile),
		).toEqual([false, false, false, false, false]);
		expect(filterReviewerFiles(snapshot.files, "hide").map(f => f.path)).toEqual(["app.ts"]);
		expect(filterReviewerFiles(snapshot.files, "only").map(f => f.path)).toEqual(["app.test.ts"]);
	});
	it("defaults to the whole task without tests, and exposes each filter without starting an LLM", () => {
		const view = overlay();
		expect(find(view.describe(), "modes")?.p).toMatchObject({ active: "task" });
		expect(find(view.describe(), "files")?.c).toHaveLength(2);
		expect(find(view.describe(), "files")?.p).toMatchObject({ selected: "all" });
		expect(JSON.stringify(view.describe())).not.toContain("Review with LLM");
		view.handleNativeEvent({ type: "select", key: "filters/tests", item: "all" });
		expect(find(view.describe(), "files")?.c).toHaveLength(3);
		view.handleInput("t");
		expect(JSON.stringify(find(view.describe(), "files"))).toContain("app.test.ts");
		expect(JSON.stringify(find(view.describe(), "files"))).not.toContain('"app.ts"');
	});
	it("retains notes on hidden files and includes them when pasted", () => {
		let feedback = "";
		const view = overlay(value => {
			feedback = value;
		});
		view.describe();
		view.handleNativeEvent({ type: "select", key: "files", item: "f0" });
		view.handleInput("A");
		view.handleInput("explain this source");
		view.handleInput("\r");
		view.handleNativeEvent({ type: "select", key: "filters/tests", item: "only" });
		view.describe();
		view.handleNativeEvent({ type: "select", key: "filters/tests", item: "hide" });
		view.handleNativeEvent({ type: "select", key: "files", item: "f0" });
		expect(JSON.stringify(view.describe())).toContain("explain this source");
		view.handleNativeEvent({ type: "action", key: "footer/paste-all", act: "paste-all", mods: [] });
		expect(feedback).toContain('"app.ts" (file): explain this source');
		expect(feedback).toContain("base aaa, HEAD bbb");
	});
	it("does not let a filter change move the target of an unfinished note", () => {
		const view = overlay();
		view.describe();
		view.handleNativeEvent({ type: "select", key: "files", item: "f0" });
		view.handleInput("A");
		view.handleInput("draft");
		view.handleNativeEvent({ type: "select", key: "filters/tests", item: "only" });
		expect(find(view.describe(), "tests")?.p).toMatchObject({ active: "hide" });
		view.handleInput("\r");
		view.handleInput("t");
		expect(find(view.describe(), "tests")?.p).toMatchObject({ active: "all" });
	});
	it("requires an explicit discard before refreshing a snapshot with notes", async () => {
		let reads = 0;
		const view = overlay(
			() => {},
			async () => {
				reads++;
				return snapshot;
			},
		);
		view.describe();
		view.handleNativeEvent({ type: "select", key: "files", item: "f0" });
		view.handleInput("A");
		view.handleInput("keep me");
		view.handleInput("\r");
		view.handleNativeEvent({ type: "action", key: "head/refresh", act: "refresh", mods: [] });
		expect(reads).toBe(0);
		expect(find(view.describe(), "confirm")).toBeDefined();
		view.handleNativeEvent({ type: "action", key: "head/refresh", act: "refresh", mods: [] });
		expect(reads).toBe(0);
		expect(find(view.describe(), "confirm")).toBeDefined();
		view.handleNativeEvent({ type: "action", key: "confirm/keep-notes", act: "keep-notes", mods: [] });
		expect(find(view.describe(), "confirm")).toBeUndefined();
	});
	it("does not paint a stale mode when a slower request finishes last", async () => {
		const pending = Promise.withResolvers<ReviewerSnapshot>();
		const view = overlay(
			() => {},
			() => pending.promise,
		);
		view.handleInput("2");
		expect(find(view.describe(), "loading")).toBeDefined();
		view.handleInput("1");
		pending.resolve({ ...snapshot, branch: "stale" });
		await pending.promise;
		await Promise.resolve();
		expect(find(view.describe(), "modes")?.p).toMatchObject({ active: "task" });
		expect(JSON.stringify(find(view.describe(), "branch"))).not.toContain("stale");
	});
});
