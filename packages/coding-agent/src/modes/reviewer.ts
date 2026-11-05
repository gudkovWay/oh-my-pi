import { ReviewerOverlay } from "@oh-my-pi/pi-tui/overlays/reviewer-overlay";
import { createReviewerCodeService } from "../lsp/reviewer";
import { cfgLspEnabled, cfgLspRequestTimeout } from "../lsp/settings";
import { cfgToolsMaxTimeout } from "../tools/settings";
import { resolveLspTimeouts } from "../tools/tool-timeouts";
import { readReviewerSnapshot } from "../utils/reviewer-snapshot";
import type { InteractiveModeContext } from "./types";

export async function showReviewer(ctx: InteractiveModeContext, baseRef?: string): Promise<void> {
	const cwd = ctx.sessionManager.getCwd();
	try {
		const snapshot = await readReviewerSnapshot(cwd, "task", baseRef);
		const feedback = await ctx.showHookCustom<string | undefined>(
			(tui, theme, keys, done) =>
				new ReviewerOverlay(tui, theme, keys, {
					snapshot,
					load: mode => readReviewerSnapshot(cwd, mode, baseRef),
					onPaste: done,
					onClose: () => done(undefined),
					code: snapshot =>
						createReviewerCodeService(
							snapshot,
							cfgLspEnabled.get(ctx.settings),
							resolveLspTimeouts(
								undefined,
								cfgLspRequestTimeout.get(ctx.settings),
								cfgToolsMaxTimeout.get(ctx.settings),
							).call * 1000,
						),
				}),
			{ overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } },
		);
		if (feedback) {
			const draft = ctx.editor.getText();
			ctx.editor.setText(draft ? draft + "\n\n" + feedback : feedback);
		}
	} catch (error) {
		ctx.showError(error instanceof Error ? error.message : String(error));
	}
}
