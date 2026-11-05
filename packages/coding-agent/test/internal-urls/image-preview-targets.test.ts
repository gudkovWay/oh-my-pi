import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createImagePreviewResolver } from "../../src/internal-urls/image-preview-targets";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg==",
	"base64",
);
let directory: string;
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-image-preview-"));
});
afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});

test("decodes actual bytes, coalesces aliases and revalidates replacement", async () => {
	await fs.writeFile(path.join(directory, "a.jpg"), png);
	await fs.symlink("a.jpg", path.join(directory, "alias.png"));
	const resolve = createImagePreviewResolver({ cwd: directory });
	const signal = new AbortController().signal;
	const [first, alias] = await Promise.all([resolve("a.jpg", signal), resolve("alias.png", signal)]);
	expect(first?.mimeType).toBe("image/png");
	expect(first?.key).toBe(alias?.key);
	expect(first?.sourcePath).toBe(path.join(directory, "a.jpg"));
	const metadata = await new Bun.Image(Buffer.from(first!.data, "base64")).metadata();
	expect(metadata.width).toBe(1);
	await fs.writeFile(path.join(directory, "a.jpg"), "not an image");
	expect(await resolve("a.jpg", signal)).toBeUndefined();
});

test("missing, remote, nonregular, corrupt and cancelled inputs stay links", async () => {
	const resolve = createImagePreviewResolver({ cwd: directory });
	const signal = new AbortController().signal;
	await fs.writeFile(path.join(directory, "bad.png"), "garbage");
	for (const href of [
		"missing.png",
		"https://example.org/a.png",
		"file://example.org/a.png",
		directory,
		"bad.png",
		"data:image/png;base64,eA==",
	]) {
		expect(await resolve(href, signal)).toBeUndefined();
	}
	await fs.writeFile(path.join(directory, "valid.png"), png);
	expect(await resolve("valid.png", AbortSignal.abort())).toBeUndefined();
});

test("byte and pixel ceilings reject input before decoding", async () => {
	const oversized = await fs.open(path.join(directory, "large.png"), "w");
	await oversized.truncate(20 * 1024 * 1024 + 1);
	await oversized.close();
	const bomb = Buffer.from(png);
	bomb.writeUInt32BE(100_000, 16);
	bomb.writeUInt32BE(100_000, 20);
	await fs.writeFile(path.join(directory, "bomb.png"), bomb);
	const resolve = createImagePreviewResolver({ cwd: directory });
	const signal = new AbortController().signal;
	expect(await resolve("large.png", signal)).toBeUndefined();
	expect(await resolve("bomb.png", signal)).toBeUndefined();
});
