import { sanitizeText } from "@oh-my-pi/pi-utils";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "../index";
import { col, item, keyed, node, span, text } from "../native/describe";
import { leafKey, type NativeNode, type NativeUiEvent } from "../native/node";
import { actionBar, actionButton, itemIndex, selectList } from "../native/overlay";
import type { ReviewDiffFile, ReviewSourceRow } from "./annotation-types";
import type { ReviewerCodeAction, ReviewerCodeResult, ReviewerCodeService, ReviewerCodeSource } from "./reviewer-types";

export interface ReviewerSymbol {
	name: string;
	character: number;
}
export function reviewerSymbols(line: string): ReviewerSymbol[] {
	return Array.from(line.matchAll(/[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*/gu), match => ({
		name: match[0],
		character: match.index,
	}));
}
const ACTIONS: readonly { id: ReviewerCodeAction; label: string; key: "h" | "d" | "y" | "i" | "r" }[] = [
	{ id: "hover", label: "Type / docs", key: "h" },
	{ id: "definition", label: "Definition", key: "d" },
	{ id: "type_definition", label: "Type definition", key: "y" },
	{ id: "implementation", label: "Implementation", key: "i" },
	{ id: "references", label: "Usages", key: "r" },
];

export class ReviewerCodeOverlay {
	#source?: ReviewerCodeSource;
	#symbols: ReviewerSymbol[] = [];
	#symbolIndex = 0;
	#locationIndex = 0;
	#textLine = 0;
	#result?: ReviewerCodeResult;
	#preview?: ReviewerCodeSource;
	#action: ReviewerCodeAction = "hover";
	#loading: string | undefined;
	#error?: string;
	#controller?: AbortController;
	#sequence = 0;
	#disposed = false;
	#native?: NativeNode;
	constructor(
		private readonly service: ReviewerCodeService,
		file: ReviewDiffFile,
		row: ReviewSourceRow,
		private readonly changed: () => void,
		private readonly close: () => void,
	) {
		void this.#run(
			"Opening source…",
			signal => service.open(file, row, signal),
			source => {
				this.#source = source;
				this.#symbols = reviewerSymbols(source.lines[source.line - 1] ?? "");
			},
		);
	}
	#update(): void {
		this.#native = undefined;
		this.changed();
	}
	#cancel(): void {
		this.#sequence++;
		this.#controller?.abort();
		this.#controller = undefined;
		this.#loading = undefined;
	}
	async #run<T>(label: string, run: (signal: AbortSignal) => Promise<T>, accept: (value: T) => void): Promise<void> {
		this.#cancel();
		const sequence = this.#sequence;
		const controller = new AbortController();
		this.#controller = controller;
		this.#loading = label;
		this.#error = undefined;
		this.#update();
		try {
			const value = await run(controller.signal);
			if (!this.#disposed && sequence === this.#sequence) accept(value);
		} catch (error) {
			if (!this.#disposed && sequence === this.#sequence && !controller.signal.aborted)
				this.#error = error instanceof Error ? error.message : String(error);
		} finally {
			if (!this.#disposed && sequence === this.#sequence) {
				this.#loading = undefined;
				this.#controller = undefined;
				this.#update();
			}
		}
	}
	#query(action: ReviewerCodeAction): void {
		const source = this.#source;
		const symbol = this.#symbols[this.#symbolIndex];
		if (!source || !symbol || this.#preview) return;
		this.#action = action;
		this.#result = undefined;
		this.#locationIndex = 0;
		this.#textLine = 0;
		void this.#run(
			"Querying language server…",
			signal => this.service.query(source, symbol.character, action, signal),
			result => {
				this.#result = result;
			},
		);
	}
	#openLocation(): void {
		const location = this.#result?.locations[this.#locationIndex];
		if (!location || this.#loading) return;
		void this.#run(
			"Opening location…",
			signal => this.service.read(location, signal),
			source => {
				this.#preview = source;
			},
		);
	}
	#back(): void {
		if (this.#loading) {
			this.#cancel();
			if (!this.#source) {
				this.close();
				return;
			}
		} else if (this.#preview) this.#preview = undefined;
		else if (this.#result) this.#result = undefined;
		else {
			this.close();
			return;
		}
		this.#error = undefined;
		this.#update();
	}
	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.#back();
			return;
		}
		if (
			matchesKey(data, "up") ||
			matchesKey(data, "down") ||
			matchesKey(data, "pageUp") ||
			matchesKey(data, "pageDown")
		) {
			const delta =
				(matchesKey(data, "up") || matchesKey(data, "pageUp") ? -1 : 1) *
				(matchesKey(data, "pageUp") || matchesKey(data, "pageDown") ? 10 : 1);
			if (this.#preview)
				this.#preview = {
					...this.#preview,
					line: Math.max(1, Math.min(this.#preview.lines.length, this.#preview.line + delta)),
				};
			else if (this.#result?.locations.length)
				this.#locationIndex = Math.max(0, Math.min(this.#result.locations.length - 1, this.#locationIndex + delta));
			else if (this.#result)
				this.#textLine = Math.max(0, Math.min(this.#result.text.split("\n").length - 1, this.#textLine + delta));
			else this.#symbolIndex = Math.max(0, Math.min(this.#symbols.length - 1, this.#symbolIndex + delta));
			this.#update();
			return;
		}
		if (matchesKey(data, "enter")) {
			if (this.#result) this.#openLocation();
			else this.#query("hover");
			return;
		}
		const action = ACTIONS.find(action => action.key === data);
		if (action) this.#query(action.id);
	}
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action") {
			if (event.act === "code-back" || event.act === "close") this.#back();
			else if (event.act === "code-diff") {
				this.#cancel();
				this.close();
			} else {
				const action = ACTIONS.find(action => event.act === `code-${action.id}`);
				if (action) this.#query(action.id);
			}
		} else if ((event.type === "select" || event.type === "activate") && !this.#loading) {
			const key = leafKey(event.key);
			if (key === "symbols" && !this.#result && !this.#preview) {
				const index = itemIndex(event.item, "s");
				if (index >= 0 && index < this.#symbols.length) {
					this.#symbolIndex = index;
					if (event.type === "activate") this.#query("hover");
				}
			} else if (key === "locations" && this.#result && !this.#preview) {
				const index = itemIndex(event.item, "l");
				if (index >= 0 && index < this.#result.locations.length) {
					this.#locationIndex = index;
					if (event.type === "activate") this.#openLocation();
				}
			} else if (key === "source" && this.#preview) {
				const index = itemIndex(event.item, "p");
				if (index >= 0 && index < this.#preview.lines.length) this.#preview = { ...this.#preview, line: index + 1 };
			}
			this.#update();
		}
	}
	describe(): NativeNode {
		if (this.#native) return this.#native;
		const source = this.#source;
		const children: NativeNode[] = [text("Inspect symbol", { tone: "accent" })];
		if (source) children.push(text(sanitizeText(`${source.path}:${source.line}`), { wrap: "word" }));
		if (this.#loading) children.push(node("spinner", { label: this.#loading }, undefined, "code-loading"));
		else if (this.#error)
			children.push(keyed(text(sanitizeText(this.#error), { wrap: "word", tone: "error" }), "code-error"));
		else if (this.#preview) {
			const preview = this.#preview;
			const start = Math.max(0, preview.line - 11);
			children.push(
				text(sanitizeText(`${preview.path}:${preview.line} · current working file · read-only`), { wrap: "word" }),
			);
			children.push(
				selectList(
					"source",
					preview.lines.slice(start, start + 21).map((line, index) =>
						item(`p${start + index}`, {
							label: [span(sanitizeText(line), "mono")],
							value: String(start + index + 1),
						}),
					),
					{ selected: `p${preview.line - 1}`, max: { lines: 14 } },
				),
			);
		} else if (this.#result) {
			children.push(
				text(
					`${ACTIONS.find(action => action.id === this.#action)?.label}: ${this.#symbols[this.#symbolIndex]?.name ?? ""}`,
				),
			);
			if (this.#result.text)
				children.push(
					selectList(
						"details",
						this.#result.text.split("\n").map((line, index) => item(`t${index}`, { label: sanitizeText(line) })),
						{ selected: `t${this.#textLine}`, max: { lines: 12 } },
					),
				);
			if (this.#result.locations.length)
				children.push(
					selectList(
						"locations",
						this.#result.locations.map((location, index) =>
							item(`l${index}`, {
								label: sanitizeText(`${location.path}:${location.line}:${location.character + 1}`),
							}),
						),
						{ selected: `l${this.#locationIndex}`, max: { lines: 12 } },
					),
				);
		} else if (source) {
			children.push(text(sanitizeText(source.lines[source.line - 1] ?? ""), { wrap: "word" }));
			children.push(
				selectList(
					"symbols",
					this.#symbols.map((symbol, index) =>
						item(`s${index}`, {
							label: sanitizeText(symbol.name),
							value: `column ${symbol.character + 1}`,
						}),
					),
					{
						selected: this.#symbols.length ? `s${this.#symbolIndex}` : null,
						max: { lines: 10 },
						empty: [span("No identifiers on this line. Return to the diff and choose another line.", "muted")],
					},
				),
			);
		}
		if (source && !this.#preview && !this.#loading && !this.#error && this.#symbols.length)
			children.push(
				actionBar(ACTIONS.map(action => actionButton(action.label, `code-${action.id}`, { keys: action.key }))),
			);
		children.push(
			actionBar([
				text("↑/↓ select · Enter inspect / preview"),
				null,
				actionButton("Back", "code-back", { keys: "escape" }),
				actionButton("Return to diff", "code-diff"),
			]),
		);
		return (this.#native = col(children, { gap: "sm" }));
	}
	render(width: number): string[] {
		const source = this.#source;
		const preview = this.#preview;
		const heading = ["Inspect symbol", source ? `${source.path}:${source.line}` : ""];
		let body: string[];
		if (this.#loading) body = [this.#loading];
		else if (this.#error) body = [this.#error];
		else if (preview) {
			const start = Math.max(0, preview.line - 7);
			body = [
				preview.path,
				...preview.lines
					.slice(start, start + 14)
					.map((line, index) => `${start + index + 1 === preview.line ? ">" : " "}${start + index + 1} ${line}`),
			];
		} else if (this.#result)
			body = this.#result.locations.length
				? [
						this.#result.text,
						...this.#result.locations
							.slice(Math.max(0, this.#locationIndex - 6), this.#locationIndex + 7)
							.map(
								location =>
									`${location === this.#result!.locations[this.#locationIndex] ? ">" : " "}${location.path}:${location.line}:${location.character + 1}`,
							),
					]
				: this.#result.text.split("\n").slice(this.#textLine, this.#textLine + 12);
		else
			body = [
				source?.lines[(source?.line ?? 1) - 1] ?? "",
				...this.#symbols.map(
					(symbol, index) =>
						`${index === this.#symbolIndex ? ">" : " "} ${symbol.name} (column ${symbol.character + 1})`,
				),
			];
		const hints =
			"↑/↓ select · Enter inspect/preview · h type/docs · d definition · y type · i implementation · r usages · Esc back";
		return [...heading, ...body, hints]
			.flatMap(line => wrapTextWithAnsi(sanitizeText(line), Math.max(1, width)))
			.map(line => truncateToWidth(line, width));
	}
	dispose(): void {
		this.#disposed = true;
		this.#cancel();
	}
}
