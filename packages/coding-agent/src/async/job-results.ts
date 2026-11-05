import type { SessionManager } from "../session/session-manager";
import type { AsyncJob } from "./job-manager";

const ENTRY_TYPE = "async-job-result";
type Journal = Pick<SessionManager, "getEntries">;
export type JobResultReceipt = Pick<
	AsyncJob,
	| "id"
	| "type"
	| "status"
	| "label"
	| "intent"
	| "ownerId"
	| "agentId"
	| "startTime"
	| "endTime"
	| "resultText"
	| "errorText"
	| "structured"
	| "latestDetails"
	| "agentOutputPublished"
>;

export interface AsyncJobResultStore {
	readonly sessionId: string;
	ids(): Iterable<string>;
	captureWriter(): (job: AsyncJob) => Promise<void>;
	read(id: string, ownerId: string | undefined): JobResultReceipt | undefined;
}

export function createJobResultStore(journal: SessionManager): AsyncJobResultStore {
	return {
		get sessionId() {
			return journal.getSessionId();
		},
		ids: () => recordedJobIds(journal),
		captureWriter() {
			const write = journal.captureCustomEntryWriter();
			return job => write(ENTRY_TYPE, jobResultData(job));
		},
		read: (id, ownerId) => readJobResult(journal, id, ownerId),
	};
}

function jobResultData(job: AsyncJob) {
	if (job.status === "running" || job.endTime === undefined) throw new Error("Cannot persist an unsettled job result");
	const {
		id,
		type,
		status,
		label,
		intent,
		ownerId,
		agentId,
		startTime,
		endTime,
		resultText,
		errorText,
		structured,
		latestDetails,
		agentOutputPublished,
	} = job;
	return {
		schema: 1,
		result: {
			id,
			type,
			status,
			label,
			intent,
			ownerId,
			agentId,
			startTime,
			endTime,
			resultText,
			errorText,
			structured,
			latestDetails,
			agentOutputPublished,
		},
	};
}

function receipt(data: unknown): JobResultReceipt | undefined {
	if (!data || typeof data !== "object" || !("schema" in data) || data.schema !== 1 || !("result" in data)) return;
	const result = data.result;
	if (!result || typeof result !== "object") return;
	const row = result as Partial<JobResultReceipt>;
	if (
		typeof row.id !== "string" ||
		typeof row.label !== "string" ||
		!["bash", "task", "eval"].includes(row.type ?? "") ||
		!["completed", "failed", "cancelled"].includes(row.status ?? "") ||
		typeof row.startTime !== "number" ||
		typeof row.endTime !== "number" ||
		(row.ownerId !== undefined && typeof row.ownerId !== "string") ||
		(row.resultText !== undefined && typeof row.resultText !== "string") ||
		(row.errorText !== undefined && typeof row.errorText !== "string")
	)
		return;
	return row as JobResultReceipt;
}

function recordedJobIds(journal: Journal): string[] {
	const ids: string[] = [];
	for (const entry of journal.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const result = receipt(entry.data);
		if (result) ids.push(result.id);
	}
	return ids;
}

export function readJobResult(
	journal: Journal | undefined,
	id: string,
	ownerId: string | undefined,
): JobResultReceipt | undefined {
	if (!journal) return;
	const entries = journal.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const result = receipt(entry.data);
		if (result?.id === id && result.ownerId === ownerId) return result;
	}
}
