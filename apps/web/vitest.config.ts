import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/unit/setup.ts"],
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      // Gate the areas unit tests are responsible for. Full-page rendering is
      // covered by e2e (root tests/e2e).
      include: ["app/**"],
      exclude: ["app/layout.tsx"],
      thresholds: {
        // Measured 2026-09-01: 100% lines / 100% branches.
        "app/**": { lines: 95, branches: 95 },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
