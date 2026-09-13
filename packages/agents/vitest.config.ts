import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // Pure re-export barrel + type declarations — nothing to measure.
      exclude: ["src/index.ts"],
      thresholds: {
        // Measured 2026-09-13: 97.9% lines / 87.4% branches.
        "src/**": { lines: 95, branches: 84 },
      },
    },
  },
});
