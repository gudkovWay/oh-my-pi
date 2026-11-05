import { realpath } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { tokenizeShellSegments } from "../tools/shell-tokenize";
import { reviewerGit } from "../utils/reviewer-snapshot";

export interface WorktrunkSelection {
	path: string;
	branch: string;
}
export function parseWorktrunkSelection(command: string, output: string): WorktrunkSelection | undefined {
	if (/[$`]|<<|[|]/.test(command)) return undefined;
	const commands = tokenizeShellSegments(command);
	const last = commands.at(-1);
	if (!last || basename(last[0] ?? "") !== "wt" || last[1] !== "switch") return undefined;
	if (!last.some((word, i) => word === "--format=json" || (word === "--format" && last[i + 1] === "json")))
		return undefined;
	if (commands.filter(args => basename(args[0] ?? "") === "wt").length !== 1) return undefined;
	const selections: WorktrunkSelection[] = [];
	for (const line of output.split("\n")) {
		try {
			const value = JSON.parse(line);
			if (
				typeof value === "object" &&
				value !== null &&
				typeof value.path === "string" &&
				isAbsolute(value.path) &&
				typeof value.branch === "string" &&
				value.branch &&
				["created", "switched", "already_current", "unchanged"].includes(value.action)
			)
				selections.push({ path: value.path, branch: value.branch });
		} catch {
			/* Worktrunk writes progress around its one JSON result. */
		}
	}
	return selections.length === 1 ? selections[0] : undefined;
}
export async function validateWorktrunkSelection(cwd: string, selection: WorktrunkSelection): Promise<string> {
	const root = await realpath(selection.path);
	const [sourceCommon, targetCommon, targetRoot, branch] = await Promise.all([
		reviewerGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
		reviewerGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
		reviewerGit(root, ["rev-parse", "--show-toplevel"]),
		reviewerGit(root, ["symbolic-ref", "--short", "HEAD"]),
	]);
	if (
		(await realpath(sourceCommon.trim())) !== (await realpath(targetCommon.trim())) ||
		(await realpath(targetRoot.trim())) !== root ||
		branch.trim() !== selection.branch
	)
		throw new Error("Worktrunk selection does not match this repository and branch");
	const gitDir = (await reviewerGit(root, ["rev-parse", "--path-format=absolute", "--git-dir"])).trim();
	if ((await realpath(gitDir)) === (await realpath(targetCommon.trim())))
		throw new Error("Worktrunk selection is not a linked worktree");
	return root;
}
