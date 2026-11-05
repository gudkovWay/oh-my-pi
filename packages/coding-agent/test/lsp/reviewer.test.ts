import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewerSnapshot } from "@oh-my-pi/pi-tui/overlays/reviewer-types";
import { createReviewerCodeService } from "../../src/lsp/reviewer";
import { configCache } from "../../src/lsp/config";
import { shutdownAll } from "../../src/lsp/client";
import { fileToUri } from "../../src/lsp/utils";

let root: string;
let snapshot: ReviewerSnapshot;
const code = 'import { sum } from "./math";\nconst result = sum(sum(1, 2), 3);\n';
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "omp-reviewer-code-"));
	await writeFile(join(root, "app.ts"), code);
	await writeFile(join(root, "math.ts"), "export function sum(a: number, b: number) { return a + b; }\n");
	snapshot = {
		root,
		branch: "task",
		ref: "main",
		base: "aaa",
		head: "bbb",
		fileHashes: { "app.ts": Bun.CryptoHasher.hash("sha256", code, "hex") },
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
						raw: "+const result = sum(sum(1, 2), 3);",
						content: "const result = sum(sum(1, 2), 3);",
						newLine: 2,
						hunkHeader: "@@ -1 +1,2 @@",
					},
				],
			},
		],
	};
	configCache.set(root, {
		servers: {
			fixture: {
				command: process.execPath,
				args: [join(import.meta.dir, "../fixtures/fake-lsp-server.ts")],
				fileTypes: [".ts"],
				rootMarkers: [],
				initOptions: {
					reviewer: { source: fileToUri(join(root, "app.ts")), target: fileToUri(join(root, "math.ts")) },
				},
			},
		},
	});
});
afterEach(async () => {
	await shutdownAll();
	configCache.delete(root);
	await rm(root, { recursive: true, force: true });
});
function selected() {
	const file = snapshot.files[0]!;
	const row = file.rows[0]!;
	if (row.kind !== "added") throw new Error("Bad test fixture");
	return { file, row };
}
describe("read-only reviewer LSP", () => {
	it("queries the exact occurrence through the native client, normalizes hover and deduplicates LocationLinks", async () => {
		const service = createReviewerCodeService(snapshot, true);
		const { file, row } = selected();
		const signal = new AbortController().signal;
		const source = await service.open(file, row, signal);
		expect((await service.query(source, 19, "hover", signal)).text).toContain("=> number");
		for (const action of ["definition", "type_definition", "implementation", "references"] as const) {
			const result = await service.query(source, 19, action, signal);
			expect(result.locations).toEqual([{ path: join(root, "math.ts"), line: 1, character: 16 }]);
			expect((await service.read(result.locations[0]!, signal)).lines[0]).toContain("export function sum");
		}
	}, 15_000);
	it("rejects snapshot drift outside the selected hunk and drift after opening the symbol picker", async () => {
		const service = createReviewerCodeService(snapshot, true);
		const { file, row } = selected();
		const signal = new AbortController().signal;
		const source = await service.open(file, row, signal);
		await writeFile(join(root, "app.ts"), code + "export const changedOutsideHunk = true;\n");
		await expect(service.open(file, row, signal)).rejects.toThrow("stale");
		await expect(service.query(source, 19, "hover", signal)).rejects.toThrow("stale");
	});
	it("does not navigate old-side rows, disabled sessions or unconfigured files", async () => {
		const { file, row } = selected();
		const signal = new AbortController().signal;
		await expect(
			createReviewerCodeService(snapshot, true).open(file, { ...row, kind: "removed", newLine: undefined }, signal),
		).rejects.toThrow("Removed lines");
		await expect(createReviewerCodeService(snapshot, false).open(file, row, signal)).rejects.toThrow("disabled");
		configCache.set(root, { servers: {} });
		const service = createReviewerCodeService(snapshot, true);
		const source = await service.open(file, row, signal);
		await expect(service.query(source, 19, "hover", signal)).rejects.toThrow("No language server");
	});
	it("enforces read-only actions at runtime and propagates cancellation before starting a client", async () => {
		const service = createReviewerCodeService(snapshot, true);
		const { file, row } = selected();
		const controller = new AbortController();
		const source = await service.open(file, row, controller.signal);
		await expect(service.query(source, 19, "rename" as "hover", controller.signal)).rejects.toThrow("read-only");
		controller.abort(new Error("cancelled"));
		await expect(service.query(source, 19, "hover", controller.signal)).rejects.toThrow("cancelled");
		expect(await Bun.file(join(root, "app.ts")).text()).toBe(code);
	});
});
