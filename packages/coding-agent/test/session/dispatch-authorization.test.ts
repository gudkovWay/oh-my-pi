import { expect, test } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { withDispatchAuthorization } from "../../src/session/settings-stream-fn";

const model = getBundledModel("openai", "gpt-4o-mini");
const context = { messages: [], systemPrompt: [], tools: [] };

test("revocation while a provider waits for admission prevents the physical send", async () => {
	const queued = Promise.withResolvers<void>();
	const admitted = Promise.withResolvers<void>();
	let active = true;
	let sent = 0;
	const transport: StreamFn = async (requestModel, _context, options) => {
		queued.resolve();
		await admitted.promise;
		await options?.onPayload?.({ model: requestModel.id }, requestModel);
		sent++;
		return new AssistantMessageEventStream();
	};
	const stream = withDispatchAuthorization(transport, async () => {
		if (!active) throw new Error("Goal revoked");
	});
	const pending = Promise.resolve(stream(model, context)).then(
		() => undefined,
		error => error,
	);
	await queued.promise;
	active = false;
	admitted.resolve();
	expect(await pending).toBeInstanceOf(Error);
	expect(sent).toBe(0);
});

test("every physical attempt and auxiliary caller passes the same live guard", async () => {
	let checks = 0;
	let sent = 0;
	const stream = withDispatchAuthorization(
		async (requestModel, _context, options) => {
			for (let attempt = 0; attempt < 2; attempt++) {
				await options?.onPayload?.({ attempt }, requestModel);
				sent++;
			}
			return new AssistantMessageEventStream();
		},
		async (actual, options) => {
			expect(actual).toBe(model);
			expect(options?.serviceTier).toBe("default");
			checks++;
		},
	);
	await stream(model, context, { serviceTier: "default" });
	expect(checks).toBe(3);
	expect(sent).toBe(2);
});

test("unguarded sessions retain the original transport without extra wrapping", () => {
	const transport: StreamFn = () => new AssistantMessageEventStream();
	expect(withDispatchAuthorization(transport)).toBe(transport);
});
