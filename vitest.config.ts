import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  resolve: {
    alias: {
      "@botroost/contracts": resolve("packages/contracts/src/index.ts"),
      "@botroost/runtime-sdk": resolve("packages/runtime-sdk/src/index.ts"),
      "@botroost/provider-sdk": resolve("packages/provider-sdk/src/index.ts"),
    },
  },
  test: { include: ["packages/**/*.test.ts"] },
});
