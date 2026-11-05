import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReviewerSnapshot } from "../src/utils/reviewer-snapshot";

let root: string;
function git(...args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd: root,
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "omp-reviewer-"));
	git("init", "-b", "dev");
	git("config", "user.name", "Reviewer fixture");
	git("config", "user.email", "reviewer@example.invalid");
	git("config", "worktrunk.default-branch", "dev");
	writeFileSync(join(root, "app.ts"), "base\n");
	git("add", "app.ts");
	git("commit", "-m", "base");
	git("update-ref", "refs/remotes/origin/dev", "HEAD");
	git("switch", "-c", "task");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("reviewer snapshots", () => {
	it("keeps the full task after commit and publication and includes staged, unstaged and new files", async () => {
		writeFileSync(join(root, "app.ts"), "committed\n");
		git("commit", "-am", "task");
		git("update-ref", "refs/remotes/origin/task", "HEAD");
		git("config", "branch.task.remote", "origin");
		git("config", "branch.task.merge", "refs/heads/task");
		git("config", "remote.origin.url", ".");
		git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
		writeFileSync(join(root, "app.ts"), "staged\n");
		git("add", "app.ts");
		writeFileSync(join(root, "app.ts"), "working\n");
		writeFileSync(join(root, "app.test.ts"), "test source\n");
		writeFileSync(join(root, "-odd name.ts"), "new source\n");
		writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
		writeFileSync(join(root, "ignored.txt"), "not reviewable\n");
		const task = await readReviewerSnapshot(root, "task");
		expect(task.ref).toBe("origin/dev");
		expect(task.branch).toBe("task");
		expect(task.files.map(file => file.path)).toContain("app.test.ts");
		expect(task.files.map(file => file.path)).toContain("-odd name.ts");
		expect(task.files.map(file => file.path)).not.toContain("ignored.txt");
		expect(task.files.find(file => file.path === "app.ts")?.rows).toContainEqual(
			expect.objectContaining({ kind: "removed", content: "base" }),
		);
		expect(task.files.find(file => file.path === "app.ts")?.rows).toContainEqual(
			expect.objectContaining({ kind: "added", content: "working" }),
		);
		expect(
			(await readReviewerSnapshot(root, "uncommitted")).files.find(file => file.path === "app.ts")?.rawDiff,
		).toContain("-committed");
		expect(
			(await readReviewerSnapshot(root, "published")).files.find(file => file.path === "app.ts")?.rawDiff,
		).toContain("-committed");
	});
	it("excludes changes made only on the target branch", async () => {
		writeFileSync(join(root, "feature.ts"), "feature\n");
		git("add", "feature.ts");
		git("commit", "-m", "feature");
		git("switch", "dev");
		writeFileSync(join(root, "other.ts"), "other\n");
		git("add", "other.ts");
		git("commit", "-m", "other");
		git("update-ref", "refs/remotes/origin/dev", "HEAD");
		git("switch", "task");
		expect((await readReviewerSnapshot(root, "task")).files.map(file => file.path)).toEqual(["feature.ts"]);
	});
	it("reports absent publication rather than changing the comparison silently", async () => {
		await expect(readReviewerSnapshot(root, "published")).rejects.toThrow("upstream");
		await expect(readReviewerSnapshot(root, "task", "missing-base")).rejects.toThrow();
	});
	it("shows human-reviewable lockfiles instead of silently applying LLM exclusions", async () => {
		writeFileSync(join(root, "bun.lock"), "lock source\n");
		expect((await readReviewerSnapshot(root, "uncommitted")).files.map(file => file.path)).toContain("bun.lock");
	});
	it("captures complete old and new Vue sources even when opening tags are outside every hunk", async () => {
		const old = ['<script setup lang="ts">', ...Array(12).fill(""), "const value = 1;", "</script>", ""];
		const current = old.map(line => line.replace("value = 1", "value = 2"));
		writeFileSync(join(root, "Component.vue"), old.join("\r\n"));
		git("add", "Component.vue");
		git("commit", "-m", "Vue baseline");
		writeFileSync(join(root, "Component.vue"), current.join("\r\n"));
		const snapshot = await readReviewerSnapshot(root, "uncommitted");
		const file = snapshot.files.find(file => file.path === "Component.vue")!;
		expect(file.rawDiff).not.toContain("<script");
		expect(file).toMatchObject({ sources: { old, new: current } });
	});
	it("keeps new, deleted, binary and gitlink changes reviewable without inventing source sides", async () => {
		git("update-index", "--add", "--cacheinfo", `160000,${git("rev-parse", "HEAD")},vendor`);
		git("commit", "-m", "gitlink baseline");
		writeFileSync(join(root, "new.ts"), "export const fresh = true;\n");
		writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
		rmSync(join(root, "app.ts"));
		const snapshot = await readReviewerSnapshot(root, "uncommitted");
		expect(snapshot.files.find(file => file.path === "new.ts")?.sources).toEqual({
			old: undefined,
			new: ["export const fresh = true;", ""],
		});
		expect(snapshot.files.find(file => file.path === "app.ts")?.sources).toEqual({
			old: ["base", ""],
			new: undefined,
		});
		expect(snapshot.files.find(file => file.path === "binary.bin")?.sources).toBeUndefined();
		expect(snapshot.files.find(file => file.path === "vendor")?.sources).toEqual({
			old: undefined,
			new: undefined,
		});
	});
	it("pins the complete working file so an edit outside the visible hunk invalidates semantic queries", async () => {
		writeFileSync(join(root, "app.ts"), "const current = 2;\n");
		const snapshot = await readReviewerSnapshot(root, "uncommitted");
		expect(snapshot.fileHashes?.["app.ts"]).toBe(Bun.CryptoHasher.hash("sha256", "const current = 2;\n", "hex"));
	});
});
