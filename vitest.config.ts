import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  resolve: {
    alias: {
      // The web app resolves its own sources through the `@/*` path alias declared in apps/web/tsconfig.json.
      "@": resolve("apps/web/src"),
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
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    exclude: ["apps/web/tests/migration-contract.test.ts"],
    // Web component tests render React into a real DOM, so they need jsdom while the
    // API/worker/database suites stay on the faster node environment.
    environmentMatchGlobs: [["apps/web/test/**", "jsdom"]],
    testTimeout: 30_000,
  },
});
