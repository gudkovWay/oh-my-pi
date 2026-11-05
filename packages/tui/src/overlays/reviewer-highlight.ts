import { highlightCode, type HighlightColors } from "@oh-my-pi/pi-natives";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { getLanguageFromPath } from "../lang-from-path";
import { replaceTabs } from "../utils";
import type { ReviewDiffFile, ReviewSourceRow } from "./annotation-types";

const TOKENS = [
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
] as const;
// A fixed ANSI palette transports token identities, not theme-dependent RGB colors.
const COLORS: HighlightColors = {
	comment: "\x1b[100m",
	keyword: "\x1b[101m",
	function: "\x1b[102m",
	variable: "\x1b[103m",
	string: "\x1b[104m",
	number: "\x1b[105m",
	type: "\x1b[106m",
	operator: "\x1b[107m",
	punctuation: "\x1b[108m",
};

/** Parse complete sides independently; hunk boundaries are not lexical boundaries. */
export function reviewerSourceSpans(file: ReviewDiffFile): Map<ReviewSourceRow, TspSpan[]> {
	const result = new Map<ReviewSourceRow, TspSpan[]>();
	const language = getLanguageFromPath(file.path);
	for (const side of ["old", "new"] as const) {
		const fullSource = file.sources?.[side];
		const fullHighlight = fullSource
			? highlightCode(fullSource.map(line => replaceTabs(sanitizeText(line))).join("\n"), language, COLORS).split(
					"\n",
				)
			: undefined;
		let rows: ReviewSourceRow[] = [];
		const flush = () => {
			if (!rows.length) return;
			const highlighted =
				fullHighlight ??
				highlightCode(rows.map(row => replaceTabs(sanitizeText(row.content))).join("\n"), language, COLORS).split(
					"\n",
				);
			for (const [index, row] of rows.entries()) {
				if (side === "old" && row.kind !== "removed") continue;
				const lineNumber = side === "old" ? row.oldLine : row.newLine;
				const sourceIndex = lineNumber === undefined ? -1 : lineNumber - 1;
				const content = replaceTabs(sanitizeText(row.content));
				const line = fullSource
					? fullSource[sourceIndex] === row.content
						? (highlighted[sourceIndex] ?? content)
						: content
					: (highlighted[index] ?? content);
				const spans: TspSpan[] = [];
				let start = 0;
				let token: string | undefined;
				for (const match of line.matchAll(/\x1b\[(\d+)m/g)) {
					if (match.index > start)
						spans.push({ t: line.slice(start, match.index), s: token ? `${token} mono` : "mono" });
					token = TOKENS[Number(match[1]) - 100];
					start = match.index + match[0].length;
				}
				if (start < line.length) spans.push({ t: line.slice(start), s: token ? `${token} mono` : "mono" });
				result.set(row, spans);
			}
			rows = [];
		};
		for (const row of file.rows) {
			if (row.kind === "hunk") flush();
			else if (row.kind === "context" || row.kind === (side === "old" ? "removed" : "added")) rows.push(row);
		}
		flush();
	}
	return result;
}
