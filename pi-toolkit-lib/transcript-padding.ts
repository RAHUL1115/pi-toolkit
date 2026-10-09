import { InteractiveMode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inChildSessionContext } from "./unified-subagents/child-context.js";

export const TOOLKIT_OUTPUT_PADDING_X = 1;
const PATCH = Symbol.for("pi-toolkit.transcript-padding.v1");
type RuntimeObject = Record<PropertyKey, any>;
type Undo = () => void;
interface PatchState {
	owner?: symbol;
	enabled: boolean;
	active?: RuntimeObject;
	undo?: Undo;
	wrapper: (...args: any[]) => any;
}

function dataPadding(object: RuntimeObject, key: string): PropertyDescriptor | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	return descriptor?.configurable && descriptor.writable && typeof descriptor.value === "number"
		? descriptor : undefined;
}

function canShadow(object: RuntimeObject, key: string): boolean {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	return descriptor ? descriptor.configurable === true : Object.isExtensible(object);
}

function restore(object: RuntimeObject, key: string, descriptor?: PropertyDescriptor): void {
	if (descriptor) Object.defineProperty(object, key, descriptor);
	else delete object[key];
}

/** Instance-only changes: never patch Container, Text, settings, or component prototypes. */
function attach(instance: RuntimeObject): Undo | undefined {
	const descriptor = dataPadding(instance, "outputPad");
	const containers = [instance.chatContainer, instance.pendingMessagesContainer];
	if (!descriptor || containers.some((container) => !container || !Array.isArray(container.children)
		|| typeof container.addChild !== "function" || !canShadow(container, "addChild"))) return;

	let native = descriptor.value as number;
	const undos: Undo[] = [];
	const seen = new WeakSet<object>();
	const patchChild = (child: RuntimeObject) => {
		if (!child || typeof child !== "object" || seen.has(child)) return;
		seen.add(child);
		if (typeof child.setOutputPad === "function" && canShadow(child, "setOutputPad")) {
			const own = Object.getOwnPropertyDescriptor(child, "setOutputPad");
			const original = child.setOutputPad;
			// Constructors read the styled instance value. Their native counterpart is the
			// instance's raw setting, not the already-styled component field.
			const wrapper = function (this: RuntimeObject, _padding: number, ...args: any[]) {
				return original.call(this, TOOLKIT_OUTPUT_PADDING_X, ...args);
			};
			Object.defineProperty(child, "setOutputPad", { configurable: true, writable: true, value: wrapper });
			undos.push(() => {
				if (child.setOutputPad !== wrapper) return;
				restore(child, "setOutputPad", own);
				original.call(child, native);
			});
			original.call(child, TOOLKIT_OUTPUT_PADDING_X);
		} else if (child.constructor?.name === "ThemedText" && typeof child.build === "function") {
			// Only direct transcript notices, never their nested Text/editor descendants.
			// Both supported hosts keep paddingX as a configurable own data field;
			// the newer host's setPaddingX also writes through this accessor.
			const padding = dataPadding(child, "paddingX");
			if (!padding) return;
			const get = () => TOOLKIT_OUTPUT_PADDING_X;
			Object.defineProperty(child, "paddingX", { configurable: true, enumerable: padding.enumerable,
				get, set: (_value: number) => {} });
			undos.push(() => {
				if (Object.getOwnPropertyDescriptor(child, "paddingX")?.get !== get) return;
				Object.defineProperty(child, "paddingX", { ...padding, value: native });
				child.invalidate?.();
			});
			child.invalidate?.();
		}
	};
	const get = () => TOOLKIT_OUTPUT_PADDING_X;
	Object.defineProperty(instance, "outputPad", { configurable: true, enumerable: descriptor.enumerable,
		get, set: (value: number) => { native = value; } });
	undos.push(() => {
		if (Object.getOwnPropertyDescriptor(instance, "outputPad")?.get === get) {
			Object.defineProperty(instance, "outputPad", { ...descriptor, value: native });
		}
	});
	const cleanup = () => { for (const undo of undos.reverse()) undo(); };
	try {
		for (const container of new Set<RuntimeObject>(containers)) {
			const own = Object.getOwnPropertyDescriptor(container, "addChild");
			const original = container.addChild;
			const wrapper = function (this: RuntimeObject, child: RuntimeObject, ...args: any[]) {
				patchChild(child);
				return original.call(this, child, ...args);
			};
			Object.defineProperty(container, "addChild", { configurable: true, writable: true, value: wrapper });
			undos.push(() => { if (container.addChild === wrapper) restore(container, "addChild", own); });
			for (const child of container.children) patchChild(child);
		}
	} catch {
		cleanup();
		return;
	}
	return cleanup;
}

/** Injectable prototype seam for deterministic tests; production uses the root host export. */
export function installTranscriptPadding(prototype: object, customStyling: boolean): Undo {
	const host = prototype as RuntimeObject;
	let state = host[PATCH] as PatchState | undefined;
	if (!state) {
		const descriptor = Object.getOwnPropertyDescriptor(host, "applyRuntimeSettings");
		if (!descriptor?.configurable || typeof descriptor.value !== "function" || !Object.isExtensible(host)) return () => {};
		const original = descriptor.value;
		state = { enabled: false, wrapper: function (this: RuntimeObject, ...args: any[]) {
			const result = original.apply(this, args);
			if (state!.active !== this) {
				state!.undo?.();
				state!.undo = undefined;
				state!.active = this;
			}
			if (state!.enabled && !state!.undo) state!.undo = attach(this);
			return result;
		} };
		Object.defineProperty(host, PATCH, { value: state });
		Object.defineProperty(host, "applyRuntimeSettings", { ...descriptor, value: state.wrapper });
	}
	// Keep one inert capture hook across reloads, even while styling is off. The
	// factory runs after applyRuntimeSettings and must enable before history replay.
	if (host.applyRuntimeSettings !== state.wrapper) return () => {};
	state.undo?.();
	state.undo = undefined;
	const owner = Symbol();
	state.owner = owner;
	state.enabled = customStyling;
	if (customStyling && state.active) state.undo = attach(state.active);
	return () => {
		if (state!.owner !== owner) return;
		state!.enabled = false;
		state!.undo?.();
		state!.undo = undefined;
		state!.owner = undefined;
	};
}

export function registerTranscriptPadding(pi: ExtensionAPI, customStyling: boolean): void {
	if (inChildSessionContext()) return;
	const cleanup = installTranscriptPadding(InteractiveMode.prototype, customStyling);
	pi.on("session_shutdown", async () => { cleanup(); });
}
