import js from "@eslint/js";
import svelte from "eslint-plugin-svelte";
import tseslint from "typescript-eslint";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  {
    // *.svelte.ts/*.svelte.js (Svelte 5 rune modules, e.g.
    // kernel/extensibility/registry.svelte.ts) are also routed through svelte-eslint-parser
    // by eslint-plugin-svelte's recommended config so it can understand rune
    // syntax - same as *.svelte files, they need the TS parser underneath to
    // understand `import type` etc.
    files: ["**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
    // Matches typescript-eslint's own recommended config, which already
    // turns this off for .ts files: TS (with the DOM lib) checks undefined
    // globals for us, and no-undef doesn't understand DOM types under the
    // svelte-eslint-parser wrapper.
    rules: { "no-undef": "off" },
  },
  {
    files: ["src/features/**/*.{ts,svelte}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{ group: ["../kernel/**", "../../kernel/**", "**/kernel/**"], message: "Features must not import from kernel." }]
      }]
    }
  },
  { ignores: ["dist/**"] }
];
