import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { localFilePath } from "../examples/herdr-local-files/open-file";

describe("Herdr local file links", () => {
	it("decodes reserved bytes and Unicode without interpreting them as URL syntax", () => {
		expect(localFilePath("file:///tmp/%D1%84%D0%B0%D0%B9%D0%BB%20%23%3F%25.md")).toBe("/tmp/файл #?%.md");
	});

	it("opens the document rather than treating a location suffix as part of its name", () => {
		expect(localFilePath("file://localhost/tmp/report.md?line=12#section")).toBe("/tmp/report.md");
	});

	it("rejects remote resources, other schemes, and terminal control bytes", () => {
		for (const target of [
			"file://remote/tmp/a",
			"https://example.com",
			"javascript:alert(1)",
			"file:///tmp/%00a",
			"file:///tmp/a\x1b",
			"",
		]) {
			expect(() => localFilePath(target)).toThrow();
		}
	});
});

describe("image link opener entrypoint", () => {
	const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=",
		"base64",
	);

	async function fixture() {
		const dir = await mkdtemp(path.join(tmpdir(), "omp-opener-test-"));
		const result = path.join(dir, "opened");
		const opener = path.join(dir, "xdg-open");
		await Bun.write(opener, '#!/bin/sh\nprintf "%s" "$1" > "$OMP_OPEN_RESULT"\n');
		await chmod(opener, 0o700);
		const requests: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				requests.push(url.pathname + url.search);
				if (url.pathname === "/missing.png") return new Response("missing", { status: 404 });
				if (url.pathname === "/wrong.png")
					return new Response("<html/>", { headers: { "Content-Type": "text/html" } });
				if (url.pathname === "/empty.png") return new Response("", { headers: { "Content-Type": "image/png" } });
				if (url.pathname === "/large.png") {
					let chunks = 0;
					const body = new ReadableStream({
						pull(controller) {
							if (chunks++ === 33) controller.close();
							else controller.enqueue(new Uint8Array(1024 * 1024));
						},
					});
					return new Response(body, { headers: { "Content-Type": "image/png" } });
				}
				return new Response(png, { headers: { "Content-Type": "image/png" } });
			},
		});
		return {
			dir,
			result,
			requests,
			url: server.url,
			async run(target: string, source: "herdr" | "kitty" = "herdr") {
				const child = Bun.spawn(
					[
						process.execPath,
						process.env.OMP_OPENER_UNDER_TEST ??
							path.join(import.meta.dir, "../examples/herdr-local-files/open-file.ts"),
						...(source === "kitty" ? [target] : []),
					],
					{
						env: {
							...process.env,
							PATH: `${dir}:${process.env.PATH}`,
							TMPDIR: dir,
							OMP_OPEN_RESULT: result,
							HERDR_PLUGIN_CLICKED_URL: source === "herdr" ? target : "",
						},
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
				return { code, stderr };
			},
			async close() {
				await server.stop(true);
				await rm(dir, { recursive: true, force: true });
			},
		};
	}

	it("downloads a clicked remote PNG and opens local image bytes through the MIME application", async () => {
		const f = await fixture();
		try {
			const run = await f.run(new URL("image.PNG?download=1#preview", f.url).href);
			expect(run).toEqual({ code: 0, stderr: "" });
			const opened = await readFile(f.result, "utf8");
			expect(path.isAbsolute(opened)).toBe(true);
			expect(path.extname(opened)).toBe(".png");
			expect(await readFile(opened)).toEqual(png);
			expect(f.requests).toEqual(["/image.PNG?download=1"]);
		} finally {
			await f.close();
		}
	});

	it("accepts Kitty URL arguments and leaves ordinary web pages in the browser", async () => {
		const f = await fixture();
		try {
			const target = new URL("article?image=cover.png", f.url).href;
			expect(await f.run(target, "kitty")).toEqual({ code: 0, stderr: "" });
			expect(await readFile(f.result, "utf8")).toBe(target);
			expect(f.requests).toEqual([]);
		} finally {
			await f.close();
		}
	});

	it("preserves Kitty links to registered non-HTTP applications", async () => {
		const f = await fixture();
		try {
			const target = "mailto:example@example.com";
			expect(await f.run(target, "kitty")).toEqual({ code: 0, stderr: "" });
			expect(await readFile(f.result, "utf8")).toBe(target);
			expect(f.requests).toEqual([]);
		} finally {
			await f.close();
		}
	});

	it("preserves local file decoding and location hints at the actual opener boundary", async () => {
		const f = await fixture();
		try {
			const image = path.join(f.dir, "файл #.png");
			await Bun.write(image, png);
			expect(await f.run(`${pathToFileURL(image).href}?line=12#preview`)).toEqual({ code: 0, stderr: "" });
			expect(await readFile(f.result, "utf8")).toBe(image);
		} finally {
			await f.close();
		}
	});

	it("does not open failed, non-image, or oversized downloads and removes partial files", async () => {
		const f = await fixture();
		try {
			for (const route of ["missing.png", "wrong.png", "empty.png", "large.png"]) {
				const run = await f.run(new URL(route, f.url).href);
				expect(run.code).toBe(1);
				expect(await Bun.file(f.result).exists()).toBe(false);
				expect((await readdir(f.dir)).sort()).toEqual(["xdg-open"]);
			}
		} finally {
			await f.close();
		}
	});
});
