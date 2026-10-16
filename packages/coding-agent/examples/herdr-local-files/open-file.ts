import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve only local file links; cursor/section hints are not part of the filename. */
export function localFilePath(target: string): string {
	if (/[\x00-\x1f\x7f]/.test(target)) throw new Error("Control bytes in file link");
	const uri = new URL(target);
	if (uri.protocol !== "file:" || (uri.hostname !== "" && uri.hostname !== "localhost")) {
		throw new Error("Only local file links are supported");
	}
	uri.search = "";
	uri.hash = "";
	const filePath = fileURLToPath(uri);
	if (/[\x00-\x1f\x7f]/.test(filePath)) throw new Error("Control bytes in file path");
	return filePath;
}

const imageSuffix = /\.(?:apng|avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)$/i;
const imageExtensions: Record<string, string> = {
	"image/apng": "png",
	"image/avif": "avif",
	"image/bmp": "bmp",
	"image/gif": "gif",
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/svg+xml": "svg",
	"image/tiff": "tiff",
	"image/webp": "webp",
	"image/x-icon": "ico",
	"image/vnd.microsoft.icon": "ico",
};
const maxImageBytes = 32 * 1024 * 1024;

async function downloadImage(target: string): Promise<string> {
	const response = await fetch(target, { signal: AbortSignal.timeout(30_000) });
	let directory: string | undefined;
	try {
		if (!response.ok) throw new Error(`Image download failed: HTTP ${response.status}`);
		const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
		const extension = Object.hasOwn(imageExtensions, mime) ? imageExtensions[mime] : undefined;
		if (!extension) throw new Error(`Unsupported image content type: ${mime}`);
		if (Number(response.headers.get("content-length")) > maxImageBytes) throw new Error("Image exceeds 32 MiB");
		if (!response.body) throw new Error("Empty image response");
		directory = await mkdtemp(path.join(tmpdir(), "omp-image-"));
		const filePath = path.join(directory, `image.${extension}`);
		const file = await open(filePath, "wx", 0o600);
		const reader = response.body.getReader();
		let bytes = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				bytes += value.byteLength;
				if (bytes > maxImageBytes) throw new Error("Image exceeds 32 MiB");
				await file.writeFile(value);
			}
			if (bytes === 0) throw new Error("Empty image response");
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
			await file.close();
		}
		// xdg-open can return before the viewer reads the file; retain it in tmpdir.
		return filePath;
	} catch (error) {
		if (directory) await rm(directory, { recursive: true, force: true });
		throw error;
	} finally {
		if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
	}
}

async function openTarget(target: string): Promise<void> {
	if (/[\x00-\x1f\x7f]/.test(target)) throw new Error("Control bytes in link");
	const uri = new URL(target);
	let destination: string;
	if (uri.protocol === "file:") {
		destination = localFilePath(target);
		const info = await stat(destination);
		if (!info.isFile() && !info.isDirectory()) throw new Error("Not a regular file or directory");
	} else if (uri.protocol === "http:" || uri.protocol === "https:") {
		destination = imageSuffix.test(uri.pathname) ? await downloadImage(target) : target;
	} else {
		// Kitty also delegates registered application schemes (mailto:, tg:, …).
		destination = target;
	}
	// An argv array, never a shell command: targets cannot become shell syntax.
	const code = await Bun.spawn(["xdg-open", destination], { stdio: ["ignore", "inherit", "inherit"] }).exited;
	process.exitCode = code;
}

if (import.meta.main) {
	try {
		await openTarget(process.argv[2] ?? process.env.HERDR_PLUGIN_CLICKED_URL ?? "");
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
