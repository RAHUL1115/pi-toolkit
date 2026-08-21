import { Buffer } from "node:buffer";
import { convertToLlm, serializeConversation, type CompactionResult, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "compact_context";
const COMMAND_NAME = "ptk-compact-context";
const HANDOFF_TYPE = "pi-toolkit:compact-context";

type CompactContextRequest = {
	customInstructions?: string;
	new?: boolean;
	nextPrompt: string;
};

function text(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function latestUserText(messages: any[]): string {
	const message = messages.findLast((candidate) => candidate.role === "user");
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return Array.isArray(message.content)
		? message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
		: "";
}

function encodeRequest(request: CompactContextRequest): string {
	return Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
}

function decodeRequest(value: string): CompactContextRequest {
	const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as CompactContextRequest;
	const nextPrompt = text(parsed.nextPrompt);
	if (!nextPrompt) throw new Error("next_prompt is required");
	return {
		customInstructions: text(parsed.customInstructions),
		new: parsed.new === true,
		nextPrompt,
	};
}

function compact(ctx: ExtensionCommandContext, customInstructions?: string): Promise<CompactionResult> {
	return new Promise((resolve, reject) => {
		ctx.compact({ customInstructions, onComplete: resolve, onError: reject });
	});
}

export default function registerCompactContext(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Complete a queued compact_context handoff",
		handler: async (args, ctx) => {
			let request: CompactContextRequest;
			try {
				request = decodeRequest(args.trim());
			} catch {
				ctx.ui.notify(`/${COMMAND_NAME} is an internal command queued by ${TOOL_NAME}`, "error");
				return;
			}

			await ctx.waitForIdle();
			ctx.ui.notify(request.new ? "Compacting context into a new chat..." : "Compacting context...", "info");
			try {
				const result = await compact(ctx, request.customInstructions);
				if (!request.new) {
					pi.sendUserMessage(request.nextPrompt);
					return;
				}

				const parentSession = ctx.sessionManager.getSessionFile();
				const compactedContext = serializeConversation(convertToLlm(ctx.sessionManager.buildSessionContext().messages));
				const switched = await ctx.newSession({
					parentSession,
					setup: async (sessionManager) => {
						sessionManager.appendCustomMessageEntry(
							HANDOFF_TYPE,
							`Context carried from the previous session after Pi compaction:\n\n<context>\n${compactedContext}\n</context>`,
							false,
							{ tokensBefore: result.tokensBefore },
						);
					},
					withSession: async (nextCtx) => {
						await nextCtx.sendUserMessage(request.nextPrompt);
					},
				});
				if (switched.cancelled) ctx.ui.notify("New chat was cancelled", "warning");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Context compaction failed: ${message}`, "error");
			}
		},
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Compact Context",
		description: "Compact the current Pi context using Pi's normal compaction settings, then submit the required next prompt. Pass new: true to move the compacted context and next prompt into a fresh chat. Only call compact_context when the user explicitly requests compact_context by its exact name.",
		promptSnippet: "Compact context only when the user explicitly names compact_context; new chat requires new: true",
		promptGuidelines: [
			"Call compact_context only when the user explicitly requests compact_context by its exact name; never call it proactively or infer consent.",
		],
		parameters: Type.Object({
			custom_instructions: Type.Optional(Type.String({ description: "Optional focus for Pi's compaction summary. Omit to use Pi's default compaction behavior." })),
			new: Type.Optional(Type.Boolean({ description: "When true, move the compacted context into a fresh chat. Defaults to false, keeping normal Pi compaction in the current session." })),
			next_prompt: Type.String({ minLength: 1, description: "Required prompt to submit automatically after compaction. The tool rejects empty or whitespace-only values." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const requestText = latestUserText(ctx.sessionManager.buildSessionContext().messages);
			if (!/\bcompact_context\b/i.test(requestText)) {
				throw new Error("compact_context requires the user to request compact_context by its exact name in their latest message");
			}

			const nextPrompt = text(params.next_prompt);
			if (!nextPrompt) throw new Error("compact_context requires a non-empty next_prompt");
			const request = {
				customInstructions: text(params.custom_instructions),
				new: params.new === true,
				nextPrompt,
			};
			pi.sendUserMessage(`/${COMMAND_NAME} ${encodeRequest(request)}`, {
				deliverAs: "followUp",
				expandPromptTemplates: true,
			});
			return {
				content: [{ type: "text", text: request.new ? "Queued context compaction and fresh-chat handoff." : "Queued context compaction." }],
				details: request,
				terminate: true,
			};
		},
	});
}
