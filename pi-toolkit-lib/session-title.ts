import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TITLE_ENTRY = "pi-toolkit:auto-title";
const LITE_MODEL_HINTS = ["luna", "mini", "haiku", "flash", "lite", "small"];

export function selectLiteModel(models: readonly Model<any>[]): Model<any> | undefined {
	for (const hint of LITE_MODEL_HINTS) {
		const token = new RegExp(`(^|[^a-z0-9])${hint}([^a-z0-9]|$)`, "i");
		const match = models.find((model) => token.test(`${model.id} ${model.name ?? ""}`));
		if (match) return match;
	}
	return undefined;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			typeof part === "object" && part !== null && (part as any).type === "text" && typeof (part as any).text === "string")
		.map((part) => part.text)
		.join(" ");
}

export function titleTranscript(messages: readonly unknown[]): string {
	const lines = messages.flatMap((message) => {
		if (typeof message !== "object" || message === null) return [];
		const { role, content } = message as { role?: string; content?: unknown };
		if (role !== "user" && role !== "assistant") return [];
		const text = contentText(content).replace(/\s+/g, " ").trim();
		return text ? [`${role}: ${text}`] : [];
	});
	return lines.slice(-12).join("\n").slice(-6000);
}

export function cleanSessionTitle(raw: string): string {
	const title = raw
		.split(/\r?\n/, 1)[0]!
		.trim()
		.replace(/^["'`]+|["'`]+$/g, "")
		.replace(/^\s*(?:#+\s*)?(?:title\s*:\s*)?/i, "")
		.replace(/[.!:;,\-–—]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return Array.from(title).slice(0, 72).join("").trim();
}

function availableModels(ctx: ExtensionContext): Model<any>[] {
	return ctx.scopedModels.length
		? ctx.scopedModels.map((entry) => entry.model)
		: ctx.modelRegistry.getAvailable();
}

function restoredGeneratedTitle(pi: ExtensionAPI, ctx: ExtensionContext): string | undefined {
	const entry = [...ctx.sessionManager.getEntries()]
		.reverse()
		.find((candidate: any) => candidate.type === "custom" && candidate.customType === TITLE_ENTRY) as
		| { data?: { name?: unknown } }
		| undefined;
	const name = entry?.data?.name;
	return typeof name === "string" && name === pi.getSessionName() ? name : undefined;
}

export default function registerAutomaticSessionTitles(pi: ExtensionAPI): void {
	let sessionId: string | undefined;
	let generatedTitle: string | undefined;
	let generation = 0;
	let controller: AbortController | undefined;

	const cancel = () => {
		generation++;
		controller?.abort();
		controller = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		cancel();
		sessionId = ctx.sessionManager.getSessionId();
		generatedTitle = restoredGeneratedTitle(pi, ctx);
	});

	pi.on("agent_end", (event, ctx) => {
		const currentName = pi.getSessionName();
		if (currentName && currentName !== generatedTitle) return;

		const transcript = titleTranscript(event.messages);
		const model = selectLiteModel(availableModels(ctx));
		if (!transcript || !model) return;

		cancel();
		controller = new AbortController();
		const signal = controller.signal;
		const requestGeneration = generation;
		const requestSessionId = ctx.sessionManager.getSessionId();

		void (async () => {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: "Generate a concise 3-7 word title for this coding session. Describe the overall topic, not the latest status. Return only the title with no quotes or punctuation.",
					messages: [{
						role: "user",
						content: [{ type: "text", text: transcript }],
						timestamp: Date.now(),
					}],
				},
				{
					maxTokens: 32,
					signal,
					timeoutMs: 15_000,
					maxRetries: 0,
					cacheRetention: "none",
				},
			);
			const title = cleanSessionTitle(contentText(response.content));
			if (!title || signal.aborted || requestGeneration !== generation || requestSessionId !== sessionId) return;

			const latestName = pi.getSessionName();
			if (latestName && latestName !== generatedTitle) return;

			pi.setSessionName(title);
			generatedTitle = title;
			pi.appendEntry(TITLE_ENTRY, { name: title });
		})().catch(() => {
			// Optional metadata must never delay or fail the main turn.
		});
	});

	pi.on("session_before_switch", cancel);
	pi.on("session_shutdown", cancel);
}
