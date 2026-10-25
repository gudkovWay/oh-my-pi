import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import type { ImagePreviewResolver, ResolvedImagePreview } from "@oh-my-pi/pi-tui/chat/image-reference-source";
import { MAX_IMAGE_INPUT_BYTES } from "@oh-my-pi/pi-tui/chat/image-loading";
import { parseImageMetadata } from "@oh-my-pi/pi-utils";
import type { ResolveContext } from "./index";
import { locateMarkdownLink } from "./hyperlink-targets";

/** One viewed session owns the queue and bounded decoded-image cache. */
export function createImagePreviewResolver(context: ResolveContext): ImagePreviewResolver {
	const cache = new Map<string, ResolvedImagePreview>();
	const inFlight = new Map<
		string,
		{ promise: Promise<ResolvedImagePreview | undefined>; signals: Set<AbortSignal> }
	>();
	let cacheBytes = 0;
	let tail: Promise<unknown> = Promise.resolve();
	return async (href, signal) => {
		try {
			if (signal.aborted) return undefined;
			const located = await locateMarkdownLink(href, context);
			if (!located || signal.aborted) return undefined;
			const sourcePath = await fs.realpath(located);
			const stat = await fs.stat(sourcePath, { bigint: true });
			if (!stat.isFile() || stat.size <= 0n || stat.size > BigInt(MAX_IMAGE_INPUT_BYTES) || signal.aborted)
				return undefined;
			const revision = `${sourcePath}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
			const cached = cache.get(revision);
			if (cached) {
				cache.delete(revision);
				cache.set(revision, cached);
				return cached;
			}
			let work = inFlight.get(revision);
			if (!work) {
				const signals = new Set([signal]);
				const cancelled = () => {
					for (const subscriber of signals) if (!subscriber.aborted) return false;
					return true;
				};
				const promise = tail
					.then(async () => {
						if (cancelled()) return undefined;
						const file = await fs.open(
							sourcePath,
							constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
						);
						try {
							const before = await file.stat({ bigint: true });
							if (
								!before.isFile() ||
								before.ino !== stat.ino ||
								before.dev !== stat.dev ||
								before.size !== stat.size ||
								before.mtimeNs !== stat.mtimeNs ||
								before.ctimeNs !== stat.ctimeNs
							)
								return undefined;
							const bytes = Buffer.alloc(Number(before.size) + 1);
							let offset = 0;
							while (offset < bytes.length && !cancelled()) {
								const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
								if (bytesRead === 0) break;
								offset += bytesRead;
							}
							const after = await file.stat({ bigint: true });
							if (
								cancelled() ||
								offset !== Number(before.size) ||
								after.size !== before.size ||
								after.mtimeNs !== before.mtimeNs ||
								after.ctimeNs !== before.ctimeNs
							)
								return undefined;
							const input = bytes.subarray(0, offset);
							const metadata = parseImageMetadata(input);
							if (!metadata?.width || !metadata.height || metadata.width * metadata.height > 40_000_000)
								return undefined;
							const scale = Math.min(1, 1600 / metadata.width, 1200 / metadata.height);
							const data = await new Bun.Image(input)
								.resize(
									Math.max(1, Math.round(metadata.width * scale)),
									Math.max(1, Math.round(metadata.height * scale)),
								)
								.png()
								.toBase64();
							if (cancelled()) return undefined;
							const value = {
								key: `local-image:${createHash("sha256").update(input).digest("hex")}`,
								sourcePath,
								data,
								mimeType: "image/png",
							};
							cache.set(revision, value);
							cacheBytes += data.length;
							for (const [oldest, image] of cache) {
								if (cacheBytes <= 32 * 1024 * 1024) break;
								cache.delete(oldest);
								cacheBytes -= image.data.length;
							}
							return value;
						} finally {
							await file.close();
						}
					})
					.catch(() => undefined)
					.finally(() => inFlight.delete(revision));
				work = { promise, signals };
				inFlight.set(revision, work);
				tail = promise;
			}
			work.signals.add(signal);
			const result = await work.promise;
			return signal.aborted ? undefined : result;
		} catch {
			return undefined;
		}
	};
}
