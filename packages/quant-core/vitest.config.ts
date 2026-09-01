import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      thresholds: {
        // Measured 2026-09-01: 96.8% lines / 81.7% branches.
        "src/**": { lines: 95, branches: 80 },
      },
    },
  },
});
