import { existsSync } from "node:fs";
import path from "node:path";
import swc from "unplugin-swc";
import { defineConfig, type Plugin } from "vitest/config";

// Sources use NodeNext ".js" specifiers that point at ".ts" files on disk —
// vite doesn't rewrite those, so map them here.
function resolveJsToTs(): Plugin {
  return {
    name: "resolve-js-to-ts",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !source.startsWith(".") || !source.endsWith(".js")) return null;
      const candidate = path.resolve(path.dirname(importer), source).replace(/\.js$/, ".ts");
      return existsSync(candidate) ? candidate : null;
    },
  };
}

export default defineConfig({
  // Nest needs legacy decorators + decorator metadata (design:paramtypes) —
  // esbuild can't emit metadata, so transpile with SWC.
  plugins: [
    resolveJsToTs(),
    swc.vite({
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: "es2022",
      },
      module: { type: "es6" },
    }),
  ],
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      // src/main.ts is the bootstrap entrypoint — exercised by e2e, not unit.
      include: ["src/**"],
      exclude: ["src/main.ts"],
      thresholds: {
        // Measured 2026-09-02: all-files 95.1% lines / 91.1% branches;
        // market-data 98.4% / 93.5%, sentinel 100% / 95.3%, cli 88.5% / 84%
        // (the CLI wrappers' main() and the live-gated smoke path are the
        // uncovered residue). Note: the branch thresholds were NOT met at commit
        // ed3317b (workstream A landed at 77.3% / 78.5% — `test:coverage` was
        // red there); the sentinel work added the provider-shape tests that
        // brought both globs back above their thresholds.
        "src/market-data/**": { lines: 90, branches: 85 },
        "src/**": { lines: 90, branches: 80 },
      },
    },
  },
});
