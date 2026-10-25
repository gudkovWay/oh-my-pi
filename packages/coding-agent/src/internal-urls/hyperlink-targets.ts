import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { fileUriForTerminal } from "@oh-my-pi/pi-tui/render/hyperlink";
import { extractUriScheme, InternalUrlRouter, parseInternalUrl, type ResolveContext } from "./index";
import { expandPath } from "../tools/path-utils";

/** Locate only linkable local resources; never invoke a materializing resolver. */
export async function locateMarkdownLink(href: string, context?: ResolveContext): Promise<string | null> {
	if (!href || /[\x00-\x1f\x7f]/.test(href) || /^(?:#|\?|\/\/)/.test(href)) return null;
	const scheme = extractUriScheme(href);
	const router = InternalUrlRouter.instance();
	if (scheme && scheme !== "file" && !(router.spec(scheme)?.linkable && router.canHandle(href))) return null;
	if (router.canHandle(href)) return router.locate(href, context);
	const suffixIndex = href.search(/[?#]/);
	const filePath = suffixIndex < 0 ? href : href.slice(0, suffixIndex);
	const decoded = scheme === "file" ? url.fileURLToPath(href) : decodeURIComponent(filePath);
	return path.resolve(context?.cwd ?? process.cwd(), expandPath(decoded));
}

/**
 * Resolve Markdown link destinations (as extracted by `getMarkdownLinkUrls`)
 * to existing local resources or absolute file URLs. Relative paths use the
 * calling session's cwd; missing, virtual, and remote targets stay unchanged.
 */
export async function resolveMarkdownLinkHrefs(
	hrefs: Iterable<string>,
	context?: ResolveContext,
): Promise<ReadonlyMap<string, string>> {
	const targets = new Map<string, string>();
	const urls = new Set<string>();
	const router = InternalUrlRouter.instance();
	for (const href of hrefs) {
		if (!href || /[\x00-\x1f\x7f]/.test(href) || /^(?:#|\?|\/\/)/.test(href)) continue;
		const scheme = extractUriScheme(href);
		// Rendering must not fetch remote resources or materialize secrets:
		// only linkable schemes locate locally and cheaply.
		if (!scheme || scheme === "file" || (router.spec(scheme)?.linkable && router.canHandle(href))) {
			urls.add(href);
		}
	}
	await Promise.all(
		[...urls].map(async href => {
			try {
				const sourcePath = await locateMarkdownLink(href, context);
				if (sourcePath === null) return;
				const suffixIndex = href.search(/[?#]/);
				const suffix = router.canHandle(href)
					? parseInternalUrl(href).hash
					: suffixIndex < 0
						? ""
						: href.slice(suffixIndex);
				const stat = await fs.stat(sourcePath);
				if (!stat.isFile() && !stat.isDirectory()) return;
				targets.set(href, fileUriForTerminal(sourcePath, undefined, TERMINAL.id) + suffix);
			} catch {
				// A model-authored link may be incomplete, stale, or outside the resource root.
			}
		}),
	);
	return targets;
}
