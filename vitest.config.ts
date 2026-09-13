import { defineConfig } from "vitest/config";

export default defineConfig({
  // The real print-mode suite loads Pi recursively. Keep one pi-ai registry so
  // the faux provider registered by the tests is visible to child sessions.
  test: {
    // Real-Pi suites construct nested sessions and are CPU-heavy on Windows.
    // Running files concurrently starves individual 30s guards and leaves
    // timed-out worktrees/sessions behind; serialize files for deterministic cleanup.
    // The full suite can take 6-10 minutes here; use at least a 10-minute watchdog.
    fileParallelism: false,
    server: { deps: { inline: [/@earendil-works\/pi-/] } },
    coverage: {
      provider: "istanbul",
      reporter: ["text", "html"],
      include: ["index.ts", "pi-toolkit-lib/**/*.ts"],
    },
  },
  resolve: { dedupe: ["@earendil-works/pi-ai"] },
});
