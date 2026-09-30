// The pinned upstream package publishes a generated .ts entrypoint for Pi's loader,
// without declarations. Describe only the registrar Toolkit consumes.
declare module "@narumitw/pi-goal/dist/index.ts" {
	import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
	export default function registerGoal(pi: ExtensionAPI): void;
}
