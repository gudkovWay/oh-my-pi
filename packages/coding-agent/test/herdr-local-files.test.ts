import { describe, expect, it } from "bun:test";
import { localFilePath } from "../examples/herdr-local-files/open-file";

describe("Herdr local file links", () => {
	it("decodes reserved bytes and Unicode without interpreting them as URL syntax", () => {
		expect(localFilePath("file:///tmp/%D1%84%D0%B0%D0%B9%D0%BB%20%23%3F%25.md")).toBe("/tmp/файл #?%.md");
	});

	it("opens the document rather than treating a location suffix as part of its name", () => {
		expect(localFilePath("file://localhost/tmp/report.md?line=12#section")).toBe("/tmp/report.md");
	});

	it("rejects remote resources, other schemes, and terminal control bytes", () => {
		for (const target of [
			"file://remote/tmp/a",
			"https://example.com",
			"javascript:alert(1)",
			"file:///tmp/%00a",
			"file:///tmp/a\x1b",
			"",
		]) {
			expect(() => localFilePath(target)).toThrow();
		}
	});
});
