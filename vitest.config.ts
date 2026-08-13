import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  resolve: {
    alias: {
      "@botroost/contracts": resolve("packages/contracts/src/index.ts"),
      "@botroost/runtime-sdk": resolve("packages/runtime-sdk/src/index.ts"),
      "@botroost/agent-protocol": resolve("packages/agent-protocol/src/index.ts"),
      "@botroost/provider-sdk": resolve("packages/provider-sdk/src/index.ts"),
      "@botroost/database": resolve("packages/database/src/index.ts"),
      "@botroost/auth": resolve("packages/auth/src/index.ts"),
      "@botroost/worker": resolve("apps/worker/src/index.ts"),
      "@botroost/agent-journal": resolve("packages/agent-journal/src/index.ts"),
    },
  },
  test: { include: ["packages/**/*.test.ts", "apps/**/*.test.ts"] },
});
