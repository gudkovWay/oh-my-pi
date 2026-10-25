import { Image, type ImageBudget } from "../components/image";
import type { Component } from "../tui";
import type { DescribeContext, NativeNode } from "../native/node";
import { resolveImageOptions } from "../render/render-utils";
import { theme } from "../theme";
import type { ImagePreviewResolver, ResolvedImagePreview } from "./image-reference-source";

let nextPreviewId = 0;
export class ImageReferenceFigure implements Component {
	readonly #abort = new AbortController();
	readonly #budget?: ImageBudget;
	readonly #key = `preview:${++nextPreviewId}`;
	#image?: Image;
	#pending = true;
	#value?: ResolvedImagePreview;
	#disposed = false;

	constructor(href: string, resolve: ImagePreviewResolver, budget: ImageBudget | undefined, onChange: () => void) {
		this.#budget = budget;
		const timeout = setTimeout(() => this.#abort.abort(), 2000);
		this.#abort.signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				this.#pending = false;
				if (!this.#disposed) onChange();
			},
			{ once: true },
		);
		void resolve(href, this.#abort.signal)
			.then(value => {
				if (this.#abort.signal.aborted || !value) return;
				this.#value = value;
				this.#image = new Image(
					value.data,
					value.mimeType,
					{ fallbackColor: text => theme.fg("dim", text) },
					{
						...resolveImageOptions(),
						sourcePath: value.sourcePath,
						budget,
						imageKey: this.#key,
						requestRender: onChange,
					},
				);
			})
			.catch(() => {})
			.finally(() => {
				clearTimeout(timeout);
				if (this.#abort.signal.aborted) return;
				this.#pending = false;
				onChange();
			});
	}

	get pending(): boolean {
		return this.#pending;
	}
	get sourceKey(): string | undefined {
		return this.#value?.key;
	}
	render(width: number): readonly string[] {
		return this.#image?.render(width) ?? [];
	}
	describe(cx: DescribeContext): NativeNode | null {
		return this.#image?.describe(cx) ?? null;
	}
	invalidate(): void {
		this.#image?.invalidate();
	}
	dispose(): void {
		this.#disposed = true;
		this.#abort.abort();
		this.#budget?.release(this.#key);
		this.#image = undefined;
		this.#value = undefined;
	}
}
