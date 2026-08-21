import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  test: {
    include: ["src/**/*.test.ts", "integrations/**/*.test.mjs"],
    setupFiles: ["./src/kernel/storage/setup.ts"],
  },
});
