import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // The rich-results component tests render .tsx surfaces server-side; give
  // esbuild the automatic JSX runtime (Next's SWC build is unaffected).
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
  test: {
    include: ["__tests__/**/*.test.ts"],
    environment: "node",
    // F48: observes every test file's fetch and fails the run if a suite tries
    // to generate against, or unload/reload, the endpoint the operator has
    // configured on disk. See the header of that file for what it can and
    // cannot see.
    setupFiles: ["__tests__/support/live-provider-guard.ts"],
  },
});
