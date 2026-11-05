import type { ReviewDiffFile, ReviewSourceRow } from "./annotation-types";

export type ReviewerMode = "task" | "uncommitted" | "published";
export type ReviewerTestFilter = "hide" | "all" | "only";
export interface ReviewerSnapshot {
	root: string;
	branch: string;
	ref: string;
	base: string;
	head: string;
	files: readonly ReviewDiffFile[];
	fileHashes?: Readonly<Record<string, string>>;
}
export function isReviewerTestFile(path: string): boolean {
	return /(?:^|\/)[^/]*\.test(?:\.[^/]+)?$/.test(path);
}
export function filterReviewerFiles(
	files: readonly ReviewDiffFile[],
	filter: ReviewerTestFilter,
): readonly ReviewDiffFile[] {
	if (filter === "all") return files;
	return files.filter(file => isReviewerTestFile(file.path) === (filter === "only"));
}

export type ReviewerCodeAction = "hover" | "definition" | "type_definition" | "implementation" | "references";
export interface ReviewerCodeSource {
	path: string;
	line: number;
	lines: readonly string[];
	fileHash: string;
}
export interface ReviewerCodeLocation {
	path: string;
	line: number;
	character: number;
}
export interface ReviewerCodeResult {
	text: string;
	locations: readonly ReviewerCodeLocation[];
}
export interface ReviewerCodeService {
	open(file: ReviewDiffFile, row: ReviewSourceRow, signal: AbortSignal): Promise<ReviewerCodeSource>;
	query(
		source: ReviewerCodeSource,
		character: number,
		action: ReviewerCodeAction,
		signal: AbortSignal,
	): Promise<ReviewerCodeResult>;
	read(location: ReviewerCodeLocation, signal: AbortSignal): Promise<ReviewerCodeSource>;
}
