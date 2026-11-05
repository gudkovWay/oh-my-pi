import { join } from "node:path";
import { readReviewerSource } from "./reviewer-source";
import type { ReviewerMode, ReviewerSnapshot } from "@oh-my-pi/pi-tui/overlays/reviewer-types";
import { parseReviewDiffSnapshot } from "../extensibility/custom-commands/bundled/review/diff";

export async function reviewerGit(cwd: string, args: string[], allowDifference = false): Promise<string> {
	const child = Bun.spawn(["git", "--no-optional-locks", "--literal-pathspecs", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	const [out, err, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exit !== 0 && !(allowDifference && exit === 1)) throw new Error(err.trim() || "Git operation failed");
	return out;
}
async function optionalGit(cwd: string, args: string[]): Promise<string | undefined> {
	try {
		return (await reviewerGit(cwd, args)).trim() || undefined;
	} catch {
		return undefined;
	}
}
async function taskRef(cwd: string): Promise<string> {
	const preferred = await optionalGit(cwd, ["config", "--get", "worktrunk.default-branch"]);
	const candidates = [
		...(preferred ? ["origin/" + preferred, preferred] : []),
		"origin/HEAD",
		"origin/dev",
		"origin/main",
		"origin/master",
		"dev",
		"main",
		"master",
	];
	for (const ref of candidates)
		if (await optionalGit(cwd, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"])) return ref;
	throw new Error("No task base found. Set worktrunk.default-branch or open /reviewer <base-ref>.");
}

async function workingSources(root: string, paths: readonly string[]) {
	const hashes: Record<string, string> = Object.create(null);
	const sources = new Map<string, readonly string[]>();
	for (const path of paths) {
		try {
			const source = await readReviewerSource(join(root, path));
			hashes[path] = source.fileHash;
			sources.set(path, source.lines);
		} catch {
			// Deleted, binary and oversized files remain reviewable without source context.
		}
	}
	return { hashes, sources };
}

async function baseSource(root: string, base: string, path: string): Promise<string[] | undefined> {
	const object = `${base}:${path}`;
	if ((await optionalGit(root, ["cat-file", "-t", object])) !== "blob") return undefined;
	const size = await optionalGit(root, ["cat-file", "-s", object]);
	if (size === undefined || Number(size) > 2 * 1024 * 1024) return undefined;
	const content = await reviewerGit(root, ["cat-file", "blob", object]);
	return content.includes("\0") ? undefined : content.split(/\r?\n/);
}

export async function readReviewerSnapshot(
	cwd: string,
	mode: ReviewerMode,
	explicitBase?: string,
): Promise<ReviewerSnapshot> {
	const root = (await reviewerGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
	const head = (await reviewerGit(root, ["rev-parse", "--verify", "HEAD"])).trim();
	const branch = (await optionalGit(root, ["symbolic-ref", "--short", "HEAD"])) ?? "detached HEAD";
	let ref: string;
	let base: string;
	if (mode === "uncommitted") {
		ref = "HEAD";
		base = head;
	} else if (mode === "published") {
		const upstream = await optionalGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
		if (!upstream) throw new Error("No upstream configured for this branch. Publish it and set its upstream first.");
		ref = upstream;
		base = (await reviewerGit(root, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"])).trim();
	} else {
		ref = explicitBase || (await taskRef(root));
		const target = (await reviewerGit(root, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"])).trim();
		base = (await reviewerGit(root, ["merge-base", target, head])).trim();
	}
	const diffArgs = [
		"--no-ext-diff",
		"--no-textconv",
		"--no-color",
		"--no-renames",
		"--src-prefix=a/",
		"--dst-prefix=b/",
		"--unified=3",
	];
	const untracked = (await reviewerGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]))
		.split("\0")
		.filter(Boolean);
	const changed = (await reviewerGit(root, ["diff", "--name-only", "-z", base, "--"])).split("\0").filter(Boolean);
	const paths = [...new Set([...changed, ...untracked])];
	const { hashes: before } = await workingSources(root, paths);
	const patches = [await reviewerGit(root, ["diff", ...diffArgs, base, "--"])];
	for (const path of untracked)
		patches.push(await reviewerGit(root, ["diff", "--no-index", ...diffArgs, "--", "/dev/null", path], true));
	const files = parseReviewDiffSnapshot(patches.join("\n"), { includeAllFiles: true }).files;
	files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	const { hashes, sources } = await workingSources(root, paths);
	if (
		paths.some(path => before[path] !== hashes[path]) ||
		(await reviewerGit(root, ["rev-parse", "--verify", "HEAD"])).trim() !== head
	)
		throw new Error("Files changed while reading the snapshot. Refresh the diff.");
	for (const file of files) {
		if (file.isBinary) continue;
		file.sources = {
			old: await baseSource(root, base, file.oldPath ?? file.path),
			new: sources.get(file.path),
		};
	}
	return { root, branch, ref, base, head, files, fileHashes: hashes };
}
