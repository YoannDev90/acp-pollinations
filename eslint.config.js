// @ts-check
import tseslint from "typescript-eslint";

/**
 * Flat ESLint config.
 *
 * Type-aware rules are on (`recommendedTypeChecked`), because the failures
 * this codebase actually makes — floating promises in a server that streams
 * updates, unchecked narrowing after a JSON parse — are invisible to both the
 * compiler and a syntax-only linter.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "scratchpad/**",
      ".tck/**",
      ".tools/**",
      // Plain Node fixtures for the MCP transport tests: not TypeScript, and
      // type-aware rules over them would buy nothing.
      "tests/helpers/*.mjs",
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // `vitest.config.ts` is in `tsconfig.json`; this config file is JS and
        // sits outside every project, so it gets the default one.
        projectService: { allowDefaultProject: ["eslint.config.js"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The project convention is `unknown` plus a narrowing check; a cast
      // silences the compiler without proving anything, so it is banned too.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      // `as` is legitimate for protocol payloads the SDK already typed
      // loosely; it is the un-checked `any` that must not sneak back in.
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
    },
  },
  {
    // Tests build ad-hoc protocol payloads; requiring a narrowing check for
    // every fixture would drown the assertions in noise.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // Test doubles implement interfaces whose methods are async by
      // contract; dropping `async` from a stub that returns immediately would
      // only obscure which side of the interface it stands in for.
      "@typescript-eslint/require-await": "off",
    },
  },
);
