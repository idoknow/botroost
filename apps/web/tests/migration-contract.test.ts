import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const webRoot = join(import.meta.dir, "..");
const packageJson = JSON.parse(readFileSync(join(webRoot, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const allDependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
const source = ["app.tsx", "pages.tsx", "main.tsx"]
  .map((file) => readFileSync(join(webRoot, "src", file), "utf8"))
  .join("\n");

const forbidden = [
  "@mantine/core",
  "@mantine/hooks",
  "@tabler/icons-react",
  "@tanstack/react-query",
  "@tanstack/react-table",
  "react-router-dom",
  "vitest",
  "@testing-library/react",
  "@testing-library/jest-dom",
  "@testing-library/user-event",
];
const required = [
  "@tailwindcss/vite",
  "class-variance-authority",
  "clsx",
  "lucide-react",
  "radix-ui",
  "sonner",
  "tailwind-merge",
  "tailwindcss",
  "tw-animate-css",
  "vaul",
];

describe("Campux web stack migration contract", () => {
  test("uses the Campux dependencies and removes the legacy UI/data/router test stacks", () => {
    for (const name of forbidden) expect(allDependencies[name], `${name} must be removed`).toBeUndefined();
    for (const name of required) expect(allDependencies[name], `${name} must be installed`).toBeDefined();
    expect(packageJson.dependencies?.vite).toMatch(/^\^?6\./);
  });

  test("does not import Mantine, Tabler, TanStack, or react-router from web source", () => {
    expect(source).not.toMatch(/@mantine|@tabler|@tanstack|react-router/);
  });

  test("renders two sidebar sections with one direct entry per fetched endpoint", () => {
    expect(source).toContain("data-sidebar-section=\"endpoints\"");
    expect(source).toContain("data-sidebar-section=\"operations\"");
    expect(source).toMatch(/endpoints\.map\s*\(/);
    expect(source).toContain("`/endpoints/${endpoint.id}`");
    expect(source).toContain("Cluster");
    expect(source).toContain("Agent nodes");
    expect(source).toContain("Runtime drivers");
    expect(source).toContain("Changes");
    expect(source).toContain("Audit");
    expect(source).toContain("Workspace");
  });
});
