import { stat } from "node:fs/promises";
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

if (import.meta.main) {
	try {
		const filePath = localFilePath(process.env.HERDR_PLUGIN_CLICKED_URL ?? "");
		const info = await stat(filePath);
		if (!info.isFile() && !info.isDirectory()) throw new Error("Not a regular file or directory");
		// An argv array, never a shell command: filenames cannot become shell syntax.
		process.exitCode = await Bun.spawn(["xdg-open", filePath], { stdio: ["ignore", "inherit", "inherit"] }).exited;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
