import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathIsWithin } from "@oh-my-pi/pi-utils";
import type {
	ReviewerCodeAction,
	ReviewerCodeResult,
	ReviewerCodeService,
	ReviewerCodeSource,
	ReviewerSnapshot,
} from "@oh-my-pi/pi-tui/overlays/reviewer-types";
import { readReviewerSource } from "../utils/reviewer-source";
import {
	getOrCreateClient,
	reconcileFileFromDisk,
	reconcileOpenFilesFromDisk,
	sendRequest,
	waitForProjectLoaded,
} from "./client";
import { getConfig } from "./config";
import { normalizeLocationResult } from "./diagnostics";
import { getLspServerForFile } from "./servers";
import type { Hover, Location, LocationLink } from "./types";
import { extractHoverText, fileToUri, uriToFile } from "./utils";

const METHODS: Record<ReviewerCodeAction, string> = {
	hover: "textDocument/hover",
	definition: "textDocument/definition",
	type_definition: "textDocument/typeDefinition",
	implementation: "textDocument/implementation",
	references: "textDocument/references",
};
const STALE = "Snapshot is stale. Refresh the diff before inspecting this code.";

export function createReviewerCodeService(
	snapshot: ReviewerSnapshot,
	enabled: boolean,
	timeoutMs = 20_000,
): ReviewerCodeService {
	async function current(source: ReviewerCodeSource, signal: AbortSignal) {
		signal.throwIfAborted();
		if (!enabled) throw new Error("LSP is disabled in this session.");
		const live = await readReviewerSource(source.path, source.line, signal);
		if (live.fileHash !== source.fileHash) throw new Error(STALE);
		return live;
	}
	return {
		async open(file, row, signal) {
			if (row.kind === "removed" || row.newLine === undefined)
				throw new Error(
					"Removed lines belong to the old revision. LSP navigation uses current working files only.",
				);
			if (!snapshot.files.includes(file) || !file.rows.includes(row))
				throw new Error("This row does not belong to the review snapshot.");
			const path = resolve(snapshot.root, file.newPath ?? file.path);
			if (!pathIsWithin(await realpath(snapshot.root), await realpath(path)))
				throw new Error("The source resolves outside the reviewed worktree.");
			const hash = snapshot.fileHashes?.[file.path];
			if (!hash)
				throw new Error(
					"No source fingerprint is available. Refresh the diff; binary and oversized files cannot use LSP.",
				);
			const source = await current({ path, line: row.newLine, lines: [], fileHash: hash }, signal);
			if (source.lines[row.newLine - 1] !== row.content) throw new Error(STALE);
			return source;
		},
		async query(source, character, action, callerSignal): Promise<ReviewerCodeResult> {
			if (!Object.hasOwn(METHODS, action))
				throw new Error("Only read-only semantic queries are allowed in the reviewer.");
			const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]);
			const live = await current(source, signal);
			const line = live.lines[source.line - 1];
			if (line === undefined || !Number.isInteger(character) || character < 0 || character >= line.length)
				throw new Error("Choose an identifier on an existing source line.");
			const server = getLspServerForFile(getConfig(snapshot.root), source.path);
			if (!server) throw new Error("No language server is configured for this file.");
			const client = await getOrCreateClient(server[1], snapshot.root, undefined, signal);
			await reconcileOpenFilesFromDisk(client, signal, fileToUri(source.path));
			await reconcileFileFromDisk(client, source.path, signal);
			await waitForProjectLoaded(client, signal);
			await current(source, signal);
			const result = await sendRequest(
				client,
				METHODS[action],
				{
					textDocument: { uri: fileToUri(source.path) },
					position: { line: source.line - 1, character },
					...(action === "references" ? { context: { includeDeclaration: true } } : {}),
				},
				signal,
			);
			await current(source, signal);
			if (action === "hover")
				return {
					text: result ? extractHoverText((result as Hover).contents) : "No hover information for this symbol.",
					locations: [],
				};
			const locations = normalizeLocationResult(
				result as Location | Location[] | LocationLink | LocationLink[] | null,
			);
			const unique = new Map<string, { path: string; line: number; character: number }>();
			let unsupported = 0;
			for (const location of locations) {
				const path = uriToFile(location.uri);
				if (!isAbsolute(path)) {
					unsupported++;
					continue;
				}
				const { line, character } = location.range.start;
				if (!Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0) continue;
				unique.set(JSON.stringify([path, line, character]), { path, line: line + 1, character });
			}
			return {
				text: unsupported
					? `${unsupported} non-file location(s) cannot be previewed.`
					: unique.size
						? ""
						: "No locations found for this symbol.",
				locations: [...unique.values()],
			};
		},
		async read(location, signal) {
			signal.throwIfAborted();
			if (!isAbsolute(location.path)) throw new Error("Only local source files can be previewed.");
			const source = await readReviewerSource(location.path, location.line, signal);
			if (!Number.isInteger(location.line) || location.line < 1 || location.line > source.lines.length)
				throw new Error("The target line no longer exists. Run the semantic query again.");
			return source;
		},
	};
}
