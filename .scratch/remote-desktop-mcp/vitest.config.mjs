// THROWAWAY isolated Cloudflare Vitest config for forced DO eviction.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    include: ["test/eviction.test.mjs"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
