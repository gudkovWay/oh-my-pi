import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as host from "../src/index";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { sessionDirForCwd } from "../src/session/session-paths";
import { HistoryStorage } from "../src/session/history-storage";
import { closeSessionIndex } from "../src/session/session-index";

const previous = process.env.PI_CODING_AGENT_DIR;
test("injected host API reads a bounded archive without importing installed source packages", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "archive-host-api-"));
	try {
		const agent = path.join(root, "agent");
		setAgentDir(agent);
		const cwd = path.join(root, "project");
		const dir = sessionDirForCwd(cwd);
		await fs.mkdir(dir, { recursive: true });
		const id = "01a12345-0000-7000-8000-000000000001";
		await Bun.write(
			path.join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`),
			[
				JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: "2026-01-01T00:00:00Z" }),
				JSON.stringify({
					type: "message",
					id: "u1",
					parentId: null,
					message: { role: "user", content: "owner request" },
				}),
			].join("\n") + "\n",
		);
		const result = await host.archiveSession(id, 1);
		expect(result.records.id).toBe(id);
		expect(result.records.project).toBe(cwd);
		expect(result.text).toContain("owner request");
		for (const method of [host.archiveProjects, host.archiveSessions, host.archivePrompts, host.archiveRecaps])
			expect(typeof method).toBe("function");
	} finally {
		HistoryStorage.close();
		closeSessionIndex();
		if (previous) setAgentDir(previous);
		else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fs.rm(root, { recursive: true, force: true });
	}
});
