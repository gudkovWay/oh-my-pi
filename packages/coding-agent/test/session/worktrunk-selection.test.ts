import { describe, expect, it } from "bun:test";
import { parseWorktrunkSelection } from "../../src/session/worktrunk-selection";
const result = JSON.stringify({
	action: "created",
	branch: "task",
	path: "/repo/task",
	created_branch: true,
	base_branch: "dev",
});
describe("Worktrunk session attribution", () => {
	it("accepts successful creation and reuse JSON from the selected Worktrunk command", () => {
		expect(parseWorktrunkSelection("wt switch --create task --base origin/dev --format json", result)).toEqual({
			path: "/repo/task",
			branch: "task",
		});
		expect(
			parseWorktrunkSelection(
				"export OMP_GUI_KEY=abc\nwt switch task --format json",
				result.replace("created", "switched"),
			),
		).toEqual({ path: "/repo/task", branch: "task" });
	});
	it("does not adopt paths printed by unrelated commands, ambiguous chains or substitutions", () => {
		expect(parseWorktrunkSelection("printf '%s' example", result)).toBeUndefined();
		expect(parseWorktrunkSelection("wt switch task --format json && printf spoof", result)).toBeUndefined();
		expect(
			parseWorktrunkSelection(
				"wt switch task --format json",
				result + "\n" + result.replace("/repo/task", "/repo/other"),
			),
		).toBeUndefined();
		expect(parseWorktrunkSelection("echo $(wt switch task --format json)", result)).toBeUndefined();
		expect(parseWorktrunkSelection("wt switch task", result)).toBeUndefined();
	});
});
