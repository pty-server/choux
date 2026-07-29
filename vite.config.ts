import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  // host: true binds 0.0.0.0 so a phone on the same LAN can reach the dev
  // server. The whole MVP is the phone test (CLIENT-MVP.md); localhost-only
  // makes it unrunnable. The ptys server must also allow this origin -
  // see --allow-origin.
  //
  // 5174, not vite's default 5173, which tabby-webserver uses. strictPort
  // because a silent fallback to another port breaks CORS at the ptys origin
  // allowlist, and that surfaces as an opaque fetch failure rather than a
  // port conflict. Fail loudly here instead.
  server: { host: true, port: 5174, strictPort: true },
});
