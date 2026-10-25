import { afterEach, beforeEach, expect, test } from "bun:test";
import { getKittyGraphics, setKittyGraphics } from "../src/kitty-graphics";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL } from "../src/terminal-capabilities";
import {
	createProcessTerminalRenderHarness,
	type ProcessTerminalRenderHarness,
} from "./process-terminal-render-harness";

const keys = [
	"HERDR_ENV",
	"HERDR_PANE_ID",
	"HERDR_TAB_ID",
	"HERDR_WORKSPACE_ID",
	"TMUX",
	"STY",
	"ZELLIJ",
	"TERM",
	"TERM_PROGRAM",
	"PI_FORCE_IMAGE_PROTOCOL",
	"PI_NO_KITTY_PLACEHOLDERS",
	"PI_KITTY_PLACEHOLDERS",
];
const saved = new Map(keys.map(key => [key, Bun.env[key]]));
const protocol = TERMINAL.imageProtocol;
const graphics = { ...getKittyGraphics() };
let harness: ProcessTerminalRenderHarness | undefined;

beforeEach(() => {
	for (const key of keys) delete Bun.env[key];
	Bun.env.HERDR_ENV = "1";
	Bun.env.TERM = "xterm-256color";
	Bun.env.TERM_PROGRAM = "herdr";
	setTerminalImageProtocol(null);
	setKittyGraphics({ unicodePlaceholders: false });
});
afterEach(() => {
	harness?.dispose();
	harness = undefined;
	for (const [key, value] of saved) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
	setTerminalImageProtocol(protocol);
	setKittyGraphics(graphics);
});

async function start(): Promise<string> {
	harness = createProcessTerminalRenderHarness(100, 30);
	await harness.settle();
	return harness.writes.join("");
}
function queryId(output: string): string {
	const match = output.match(/\x1b_Ga=q,i=(\d+),/);
	expect(match).not.toBeNull();
	return match![1]!;
}

test("Herdr enables image placements only after its matching graphics reply", async () => {
	const id = queryId(await start());
	expect(TERMINAL.imageProtocol).toBeNull();
	await harness!.feed("\x1b_Gi=17;OK\x1b\\");
	expect(TERMINAL.imageProtocol).toBeNull();
	await harness!.feed(`\x1b_Gi=${id};OK\x1b\\`);
	expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Kitty);
	expect(getKittyGraphics().unicodePlaceholders).toBe(true);
});

test("unsupported Herdr keeps text fallback", async () => {
	const id = queryId(await start());
	await harness!.feed(`\x1b_Gi=${id};ENOTSUP\x1b\\`);
	expect(TERMINAL.imageProtocol).toBeNull();
});

test("explicit graphics off prevents probing", async () => {
	Bun.env.PI_FORCE_IMAGE_PROTOCOL = "off";
	expect(await start()).not.toContain("\x1b_Ga=q");
});

test("nested tmux does not treat Herdr's marker as proof of a graphics route", async () => {
	Bun.env.TMUX = "/tmp/test,1,1";
	expect(await start()).not.toContain("\x1b_Ga=q");
});

test("placeholder opt-out survives successful negotiation", async () => {
	Bun.env.PI_NO_KITTY_PLACEHOLDERS = "1";
	const id = queryId(await start());
	await harness!.feed(`\x1b_Gi=${id};OK\x1b\\`);
	expect(getKittyGraphics().unicodePlaceholders).toBe(false);
});

test("fragmented replies negotiate without waiting for unrelated DA1 sentinels", async () => {
	const id = queryId(await start());
	await harness!.feed(`\x1b_Gi=${id};`, "OK", "\x1b\\");
	expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Kitty);
});

test("late replies cannot enable graphics after the bounded startup deadline", async () => {
	const id = queryId(await start());
	const expired = Promise.withResolvers<void>();
	harness!.terminal.onKittyGraphicsSupport(supported => {
		if (!supported) expired.resolve();
	});
	await expired.promise;
	await harness!.feed(`\x1b_Gi=${id};OK\x1b\\`);
	expect(TERMINAL.imageProtocol).toBeNull();
});
