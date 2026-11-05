import { afterEach, beforeAll, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "../src/chat/assistant-message";
import { FigureMarkdown } from "../src/chat/figure-markdown";
import type { ResolvedImagePreview } from "../src/chat/image-reference-source";
import { Markdown } from "../src/components/markdown";
import { getKittyGraphics, setKittyGraphics } from "../src/kitty-graphics";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL } from "../src/terminal-capabilities";
import { getMarkdownTheme, initTheme } from "../src/theme";
import { TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { resolveImageOptions, setInlineImageMaxRows } from "../src/render/render-utils";
import { Text } from "../src/components/text";
import { isNativeRendering, setNativeRendering } from "../src/native/state";

withoutTerminalMultiplexer();
const protocol = TERMINAL.imageProtocol;
const graphics = { ...getKittyGraphics() };
const value: ResolvedImagePreview = {
	key: "fixture",
	sourcePath: "/tmp/preview.png",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==",
};
beforeAll(async () => {
	await initTheme(false);
});
afterEach(() => {
	setTerminalImageProtocol(protocol);
	setKittyGraphics(graphics);
});

function message(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

test("a pending reference survives append, draws once, and leaves no placement after removal", async () => {
	setTerminalImageProtocol(ImageProtocol.Kitty);
	setKittyGraphics({ unicodePlaceholders: false });
	const term = new VirtualTerminal(100, 30);
	const scheduler = new VirtualRenderScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	const loaded = Promise.withResolvers<ResolvedImagePreview | undefined>();
	const landed = Promise.withResolvers<void>();
	let calls = 0;
	let visible = true;
	const figure = new FigureMarkdown("Before [picture](./a.png).", {
		markdown: text => new Markdown(text, 0, 0, getMarkdownTheme()),
		charts: false,
		budget: tui.imageBudget,
		resolveImagePreview: () => {
			calls++;
			return loaded.promise;
		},
		onChange: () => {
			tui.requestRender();
			landed.resolve();
		},
	});
	tui.setFrameProvider({
		renderFrame: () => ({ viewport: visible ? figure.render(80) : ["replacement prose"] }),
		acknowledgeHistory() {},
	});
	try {
		tui.start();
		await scheduler.settle(term);
		expect(figure.pending).toBe(true);
		figure.setText("Before [picture](./a.png).\n\nAfter.");
		loaded.resolve(value);
		await landed.promise;
		await scheduler.advance(term, 400);
		expect(figure.pending).toBe(false);
		expect(calls).toBe(1);
		expect(term.graphicsPlacements()).toHaveLength(1);
		expect(term.getViewport().join("\n")).toContain("Before");
		expect(term.getViewport().join("\n")).toContain("After.");
		const first = term.graphicsPlacements()[0]!.imageId;
		figure.restyle();
		tui.requestRender();
		await scheduler.settle(term);
		expect(term.graphicsPlacements()[0]!.imageId).toBe(first);
		expect(calls).toBe(1);
		visible = false;
		figure.dispose();
		tui.requestRender();
		await scheduler.settle(term);
		expect(term.graphicsPlacements()).toEqual([]);
	} finally {
		figure.dispose();
		tui.stop();
	}
});

test("image visibility controls reads and cancellation settles pending retirement", async () => {
	setTerminalImageProtocol(ImageProtocol.Kitty);
	let calls = 0;
	let signal: AbortSignal | undefined;
	const component = new AssistantMessageComponent(
		undefined,
		false,
		undefined,
		[],
		undefined,
		true,
		undefined,
		false,
		undefined,
		(_href, current) => {
			calls++;
			signal = current;
			return Promise.withResolvers<ResolvedImagePreview | undefined>().promise;
		},
	);
	component.setImagesVisible(false);
	component.updateContent(message("[picture](./a.png)"));
	expect(calls).toBe(0);
	component.setImagesVisible(true);
	expect(calls).toBe(1);
	expect(component.isTranscriptBlockPending()).toBe(true);
	component.setImagesVisible(false);
	expect(signal?.aborted).toBe(true);
	expect(component.isTranscriptBlockPending()).toBe(false);
	component.dispose();
});

test("nine previews obey the image budget across resize and overlay restoration", async () => {
	setTerminalImageProtocol(ImageProtocol.Kitty);
	setKittyGraphics({ unicodePlaceholders: false });
	const oldRows = resolveImageOptions().maxHeightCells ?? 20;
	setInlineImageMaxRows(1);
	const term = new VirtualTerminal(100, 100);
	const scheduler = new VirtualRenderScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	const landed = Promise.withResolvers<void>();
	let completed = 0;
	let reads = 0;
	const figure = new FigureMarkdown(
		Array.from({ length: 9 }, (_, index) => `[image ${index}](./${index}.png)`).join("\n\n"),
		{
			markdown: text => new Markdown(text, 0, 0, getMarkdownTheme()),
			charts: false,
			budget: tui.imageBudget,
			resolveImagePreview: async href => {
				reads++;
				const index = Number(href.match(/\d+/)![0]);
				const data = await new Bun.Image(Buffer.from(value.data, "base64"))
					.resize(index + 8, 8)
					.png()
					.toBase64();
				return { ...value, data, key: href };
			},
			onChange: () => {
				tui.requestRender();
				if (++completed === 9) landed.resolve();
			},
		},
	);
	tui.setFrameProvider({ renderFrame: () => ({ viewport: figure.render(term.columns) }), acknowledgeHistory() {} });
	try {
		tui.start();
		await landed.promise;
		await scheduler.advance(term, 400);
		expect(term.graphicsPlacements()).toHaveLength(8);
		term.resize(50, 100);
		tui.requestRender();
		await scheduler.advance(term, 400);
		expect(term.graphicsPlacements()).toHaveLength(8);
		tui.showOverlay(new Text("Overlay"));
		await scheduler.settle(term);
		tui.hideOverlay();
		await scheduler.advance(term, 400);
		expect(term.graphicsPlacements()).toHaveLength(8);
		expect(reads).toBe(9);
	} finally {
		figure.dispose();
		tui.stop();
		setInlineImageMaxRows(oldRows);
	}
});

test("native previews preserve text renderers without mutating provider content", async () => {
	const originalNative = isNativeRendering();
	setNativeRendering(true);
	setTerminalImageProtocol(null);
	const landed = Promise.withResolvers<void>();
	const source = message("Before [picture](./a.png).\n\nAfter.");
	const originalContent = JSON.stringify(source);
	const component = new AssistantMessageComponent(
		source,
		false,
		landed.resolve,
		[],
		undefined,
		true,
		undefined,
		false,
		{ renderers: [({ text }) => text.replace("Before", "Rendered")], contentOffset: 0 },
		async () => value,
	);
	try {
		await landed.promise;
		const description = JSON.stringify(
			component.describe({ cols: 80, reduceMotion: false, dark: true, supports: () => true, feature: () => true }),
		);
		expect(description).toContain('"k":"image"');
		expect(description).toContain("Rendered");
		expect(description).not.toContain("Before");
		expect(description).toContain("After.");
		expect(description).not.toContain("\\u001b");
		expect(JSON.stringify(source)).toBe(originalContent);
	} finally {
		component.dispose();
		setNativeRendering(originalNative);
	}
});

test("restored replies hydrate local previews when native rendering activates after construction", async () => {
	const originalNative = isNativeRendering();
	setNativeRendering(false);
	setTerminalImageProtocol(null);
	const landed = Promise.withResolvers<void>();
	let reads = 0;
	const component = new AssistantMessageComponent(
		message("Before [picture](./a.png).\n\nAfter."),
		false,
		landed.resolve,
		[],
		undefined,
		true,
		undefined,
		false,
		undefined,
		async () => {
			reads++;
			return value;
		},
	);
	try {
		expect(reads).toBe(0);
		setNativeRendering(true);
		const context = { cols: 80, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
		component.describe(context);
		expect(reads).toBe(1);
		await landed.promise;
		expect(JSON.stringify(component.describe(context))).toContain('"k":"image"');
		expect(reads).toBe(1);
	} finally {
		component.dispose();
		setNativeRendering(originalNative);
	}
});
