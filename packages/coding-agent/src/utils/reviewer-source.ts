import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { ReviewerCodeSource } from "@oh-my-pi/pi-tui/overlays/reviewer-types";

export async function readReviewerSource(path: string, line = 1, signal?: AbortSignal): Promise<ReviewerCodeSource> {
	signal?.throwIfAborted();
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
			throw new Error("LSP preview requires a regular source file smaller than 2 MiB.");
		const bytes = Buffer.alloc(Math.min(stat.size + 1, 2 * 1024 * 1024 + 1));
		let length = 0;
		while (length < bytes.length) {
			signal?.throwIfAborted();
			const result = await file.read(bytes, length, bytes.length - length, null);
			if (result.bytesRead === 0) break;
			length += result.bytesRead;
		}
		if (length > stat.size) throw new Error("Source changed while reading. Refresh the diff.");
		const content = bytes.subarray(0, length);
		if (content.includes(0)) throw new Error("LSP preview is unavailable for binary files.");
		signal?.throwIfAborted();
		return {
			path,
			line,
			lines: content.toString("utf8").split(/\r?\n/),
			fileHash: Bun.CryptoHasher.hash("sha256", content, "hex"),
		};
	} finally {
		await file.close();
	}
}
