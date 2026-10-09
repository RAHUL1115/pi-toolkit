type RuntimeMarkdown = Record<PropertyKey, any>;

/** Keep real lists at the marked reply's content column, not a synthetic nesting level. */
export function alignAssistantLists(markdown: RuntimeMarkdown): void {
	if (typeof markdown.renderList !== "function" || typeof markdown.options?.transform !== "function") return;
	const transform = markdown.options.transform;
	const renderList = markdown.renderList;
	let markedSource: string | undefined;
	let bodyLists = new Set<unknown>();
	let inBodyList = false;
	markdown.options.transform = (source: string, width: number) => {
		const result = transform(source, width);
		const marked = source.split("\n").map((line, index) => `${index === 0 ? "- " : "  "}${line}`).join("\n");
		markedSource = typeof result === "string" && (result === marked || result.endsWith(`\n\n${marked}`))
			? marked.replace(/\t/g, "   ") : undefined;
		return result;
	};
	markdown.renderList = function (token: any, depth: number, width: number, style: any): string[] {
		const messageList = depth === 0 && markedSource !== undefined
			&& token.raw.trimEnd() === markedSource.trimEnd();
		if (bodyLists.has(token) && !inBodyList && depth === 1) {
			// Native Markdown uses four columns per nesting level. This wrapper is
			// a message marker, not real list nesting: retain only its two-column gutter.
			inBodyList = true;
			try {
				return renderList.call(this, token, 0, Math.max(1, width - 2), style)
					.map((line: string) => line ? `  ${line}` : line);
			} finally {
				inBodyList = false;
			}
		}
		const previous = bodyLists;
		if (messageList) bodyLists = new Set(token.items[0].tokens.filter((item: any) => item.type === "list"));
		try {
			return renderList.call(this, token, depth, width, style);
		} finally {
			bodyLists = previous;
		}
	};
}
