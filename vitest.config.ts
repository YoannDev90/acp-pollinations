import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Scope to the TypeScript sources. Without this the default glob also
    // matches `dist/tests/*.test.js` from a prior build, and those copies
    // resolve the agent binary relative to `dist/` instead of the project root.
    include: ["tests/**/*.test.ts"],
    // The e2e suite spawns a subprocess and cancels mid-stream; give it room.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: "v8",
      // Product code only: `tests/helpers` are fixtures written to be driven,
      // and counting them would move the numbers for reasons that have nothing
      // to do with what ships. `bin/` is left out for the opposite reason —
      // the e2e suite runs it, but as a separate process whose V8 coverage
      // never reaches this report, so it would always read 0%.
      include: ["src/**"],
      reporter: ["text", "lcov"],
      // A few points under the current numbers (80.6 / 69.8 / 78.6 / 84.0),
      // so a real regression fails the run while an unrelated refactor does
      // not. Raise them alongside the tests that justify the new floor.
      thresholds: {
        statements: 77,
        branches: 66,
        functions: 75,
        lines: 80,
      },
    },
  },
});
