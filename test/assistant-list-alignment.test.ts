import { stripVTControlCharacters as stripAnsi } from "node:util";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { alignAssistantLists } from "../pi-toolkit-lib/assistant-list-alignment.js";

const mark = (source: string) => source.split("\n").map((line, index) => `${index === 0 ? "- " : "  "}${line}`).join("\n");
function component(source: string, transform = mark) {
	initTheme("dark", false);
	return new Markdown(source, 0, 0, getMarkdownTheme(), undefined, { transform });
}
const plain = (markdown: Markdown, width = 80) => markdown.render(width).map(line => stripAnsi(line).trimEnd());

describe("assistant list alignment", () => {
	it("keeps the message marker and aligns real lists with the first word", () => {
		const markdown = component("Setup is complete.\n\n- Issue tracker\n- Triage labels\n\nFollowing paragraph.");
		alignAssistantLists(markdown as any);
		expect(plain(markdown)).toEqual([
			"- Setup is complete.", "", "  - Issue tracker", "  - Triage labels", "", "  Following paragraph.",
		]);
	});

	it("preserves genuine nesting, ordered markers and wrapped continuations", () => {
		const markdown = component("Summary.\n\n1. First item with several words to wrap\n   - Nested item\n2. Second item");
		alignAssistantLists(markdown as any);
		const lines = plain(markdown, 24);
		expect(lines).toContain("  1. First item with");
		expect(lines).toContain("     several words to");
		expect(lines).toContain("     wrap");
		expect(lines).toContain("      - Nested item");
		expect(lines).toContain("  2. Second item");
		expect(markdown.render(24).every(line => visibleWidth(line) <= 24)).toBe(true);
	});

	it("handles final-response separators, resize and streaming updates", () => {
		const markdown = component("Summary.\n\n- Item", (source) => `────\n\n${mark(source)}`);
		alignAssistantLists(markdown as any);
		expect(plain(markdown)).toContain("  - Item");
		expect(plain(markdown, 12)).toContain("  - Item");
		markdown.setText("New summary.\n\n- New item");
		expect(plain(markdown)).toContain("  - New item");
	});

	it("does not alter unmarked Markdown or unrelated tool components", () => {
		const source = "Summary.\n\n- Item\n  - Nested";
		const expected = component(source, source => source);
		const actual = component(source, source => source);
		alignAssistantLists(actual as any);
		expect(plain(actual)).toEqual(plain(expected));
		const untouchedTool = component(source);
		const renderList = (untouchedTool as any).renderList;
		const assistant = component(source);
		alignAssistantLists(assistant as any);
		expect((untouchedTool as any).renderList).toBe(renderList);
		expect(plain(untouchedTool)).toContain("    - Item");
	});
});
