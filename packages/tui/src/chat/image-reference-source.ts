import { Marked } from "@oh-my-pi/pi-utils/marked";
import { lexDocument } from "../components/markdown";

export interface ResolvedImagePreview {
	key: string;
	sourcePath: string;
	data: string;
	mimeType: string;
}
export type ImagePreviewResolver = (href: string, signal: AbortSignal) => Promise<ResolvedImagePreview | undefined>;
export type ImageReferenceSegment = { kind: "markdown"; text: string } | { kind: "image-reference"; href: string };
const walker = new Marked();

export function isLocalImageReference(href: string, imageSyntax = false): boolean {
	if (!href || /[\x00-\x1f\x7f]/.test(href) || /^(?:#|\?|\/\/)/.test(href)) return false;
	const scheme = href.match(/^([a-z][a-z\d+.-]*):/i)?.[1]?.toLowerCase();
	if (scheme && !["file", "local", "artifact", "attachment"].includes(scheme)) return false;
	return imageSyntax || /\.(?:png|jpe?g|webp|gif|bmp|avif)(?:[?#].*)?$/i.test(href);
}

/** Keep reference definitions in each independently rendered prose run. */
export function imageReferenceDefinitions(text: string): string {
	const { links } = lexDocument(text);
	return Object.entries(links)
		.map(([label, link]) => `\n[${label}]: <${link.href}>${link.title ? ` ${JSON.stringify(link.title)}` : ""}`)
		.join("");
}

/** Previews follow their whole block, never splitting a list, quote or table. */
export function splitImageReferences(
	text: string,
	definitions = "",
	seen = new Set<string>(),
): ImageReferenceSegment[] {
	const segments: ImageReferenceSegment[] = [];
	let cursor = 0;
	let proseStart = 0;
	for (const block of lexDocument(text + (definitions ? "\n\n" + definitions : ""))) {
		const raw = block.raw.trimEnd();
		const start = text.indexOf(raw, cursor);
		if (!raw || start < 0) continue;
		cursor = Math.min(text.length, start + block.raw.length);
		const hrefs: string[] = [];
		walker.walkTokens([block], token => {
			if (
				(token.type !== "link" && token.type !== "image") ||
				!isLocalImageReference(token.href, token.type === "image") ||
				seen.has(token.href)
			)
				return;
			seen.add(token.href);
			hrefs.push(token.href);
		});
		if (hrefs.length === 0) continue;
		segments.push({ kind: "markdown", text: text.slice(proseStart, cursor) });
		for (const href of hrefs) segments.push({ kind: "image-reference", href });
		proseStart = cursor;
	}
	if (proseStart < text.length) segments.push({ kind: "markdown", text: text.slice(proseStart) });
	return segments;
}

export function hasImageReference(text: string): boolean {
	return splitImageReferences(text).some(segment => segment.kind === "image-reference");
}
