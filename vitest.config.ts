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
  },
});
