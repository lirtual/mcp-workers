// THROWAWAY isolated Cloudflare Vitest config for forced DO eviction.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    // Pinned plugin 1.0.0 bundles workerd only through 2026-08-27; this
    // test override does not alter the standalone Wrangler or production date.
    miniflare: { compatibilityDate: "2026-08-27" },
  })],
  test: {
    include: ["test/eviction.test.mjs"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
