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
        // Measured 2026-09-01: market-data 100% lines / 94.6% branches,
        // src overall 100% lines / 93.8% branches.
        "src/market-data/**": { lines: 90, branches: 85 },
        "src/**": { lines: 90, branches: 80 },
      },
    },
  },
});
