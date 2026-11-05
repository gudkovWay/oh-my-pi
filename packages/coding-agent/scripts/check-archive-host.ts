import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const cli = process.argv.slice(2).map(arg => (arg.includes("/") ? path.resolve(arg) : arg));
assert(cli.length, "Usage: bun packages/coding-agent/scripts/check-archive-host.ts <cli> [cli entrypoint]");
const work = await fs.mkdtemp(path.join(os.tmpdir(), "omp-archive-host-"));
try {
	const cwd = path.join(work, "project");
	const agentDir = path.join(work, "agent");
	const result = path.join(work, "result.json");
	const extension = path.join(work, "archive-probe.mjs");
	await Promise.all([cwd, agentDir, path.join(work, "home")].map(dir => fs.mkdir(dir, { recursive: true })));
	await Bun.write(
		extension,
		`
import assert from "node:assert/strict";
export default function(api) {
	api.registerProvider("archive-fixture", {
		baseUrl: "http://127.0.0.1:9", apiKey: "offline-fixture", api: "openai-completions",
		models: [{id:"unused",name:"Unused",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:1024}],
	});
	api.registerCommand("archive-host-probe", { handler: async (_args, ctx) => {
		try {
			for (const method of ["archiveProjects", "archiveSessions", "archiveSession", "archivePrompts", "archiveRecaps"])
				assert.equal(typeof api.pi[method], "function", method);
			const manager = api.pi.SessionManager.create(ctx.cwd);
			manager.appendMessage({role:"user",content:"bounded installed archive fixture",timestamp:Date.now()});
			await manager.ensureOnDisk();
			await manager.flush();
			const view = await api.pi.archiveSession(manager.getSessionId(), 1);
			assert.equal(view.records.id, manager.getSessionId());
			assert.equal(view.records.project, ctx.cwd);
			assert.match(view.text, /bounded installed archive fixture/);
			const originId = ctx.sessionManager.getSessionId();
			const originalFile = ctx.sessionManager.getSessionFile();
			const write = api.captureEntryWriter();
			assert.equal((await ctx.newSession()).cancelled, false);
			await write("archive-host-origin", {originId});
			assert.equal(ctx.sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === "archive-host-origin"), false);
			const origin = await api.pi.SessionManager.open(originalFile);
			try {
				assert.equal(origin.getEntries().filter(entry => entry.type === "custom" && entry.customType === "archive-host-origin").length, 1);
			} finally { await origin.close(); }
			await Bun.write(${JSON.stringify(result)}, JSON.stringify({archive:true, bounded:true, origin:true}));
		} finally { ctx.shutdown(); }
	}});
}`,
	);
	const child = Bun.spawn(
		[
			...cli,
			"--no-extensions",
			"--extension",
			extension,
			"--no-tools",
			"--no-lsp",
			"--no-skills",
			"--no-rules",
			"--no-title",
			"--model",
			"archive-fixture/unused",
			"--print",
			"/archive-host-probe",
		],
		{
			cwd,
			env: {
				PATH: process.env.PATH,
				HOME: path.join(work, "home"),
				XDG_DATA_HOME: path.join(work, "xdg"),
				PI_CODING_AGENT_DIR: agentDir,
				TMPDIR: work,
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 120_000,
		},
	);
	const [exit, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	assert.equal(exit, 0, `Archive host CLI failed (${exit})\n${stdout}\n${stderr}`);
	const captured = await Bun.file(result)
		.json()
		.catch(error => {
			throw new Error(`Archive host probe did not complete\n${stdout}\n${stderr}`, { cause: error });
		});
	assert.deepEqual(captured, { archive: true, bounded: true, origin: true });
	console.log("Compiled extension host archive API passed; no source-package import or provider request");
} finally {
	await fs.rm(work, { recursive: true, force: true });
}
