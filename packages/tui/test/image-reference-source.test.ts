import { expect, test } from "bun:test";
import { splitImageReferences } from "../src/chat/image-reference-source";

test("previews follow prose blocks while duplicate targets remain ordinary links", () => {
	const text = "Before [photo](./a.png).\n\nAfter ![again](./a.png) and ![second](./b.webp).";
	expect(splitImageReferences(text)).toEqual([
		{ kind: "markdown", text: "Before [photo](./a.png)." },
		{ kind: "image-reference", href: "./a.png" },
		{ kind: "markdown", text: "\n\nAfter ![again](./a.png) and ![second](./b.webp)." },
		{ kind: "image-reference", href: "./b.webp" },
	]);
});

test("code, remote URLs and unfinished destinations never become previews", () => {
	const text =
		"`[code](a.png)`\n\n```md\n![code](b.png)\n```\n\n![remote](https://example.org/c.png)\n\n[partial](local://d.png";
	expect(splitImageReferences(text).filter(part => part.kind === "image-reference")).toEqual([]);
});

test("references resolve before splitting and list structure remains intact", () => {
	const text = "- [one][pic]\n- two\n\n[pic]: <file:///tmp/a%20b.png>\n";
	const parts = splitImageReferences(text);
	expect(parts.filter(part => part.kind === "image-reference")).toEqual([
		{ kind: "image-reference", href: "file:///tmp/a%20b.png" },
	]);
	expect(parts[0]).toEqual({ kind: "markdown", text: "- [one][pic]\n- two" });
});
