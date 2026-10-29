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
  },
});
