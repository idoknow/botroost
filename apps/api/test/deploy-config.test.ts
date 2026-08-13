import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const compose = readFileSync(resolve(root, "deploy/compose.yml"), "utf8");
const caddy = readFileSync(resolve(root, "deploy/Caddyfile"), "utf8");
const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
const entrypoint = readFileSync(resolve(root, "deploy/node-entrypoint.sh"), "utf8");

describe("deployment release configuration", () => {
  it("keeps proxy trust explicit and exposes the production Caddy host on the shared network", () => {
    expect(compose).toContain('TRUST_PROXY: "1"');
    expect(compose).not.toContain('TRUST_PROXY: "true"');
    expect(compose).toContain("shared-network:");
    expect(caddy).toContain("botroost.facrd.xyz");
    expect(caddy).toContain("reverse_proxy web:8080");
  });

  it("initializes the named agent state volume before the node user writes to it", () => {
    expect(compose).toContain("agent-state-init:");
    expect(compose).toContain("chown -R 1000:1000 /var/lib/botroost-agent");
    expect(compose).toMatch(/agent:[\s\S]*depends_on:[\s\S]*agent-state-init: \{condition: service_completed_successfully\}/);
  });

  it("reads mounted secrets before dropping runtime privileges", () => {
    expect(dockerfile).not.toContain("USER node\nENTRYPOINT");
    expect(entrypoint).toContain("read_secret");
    expect(entrypoint).toContain("setpriv --reuid=node --regid=node --init-groups");
    expect(entrypoint.indexOf('read_secret "$variable"')).toBeLessThan(entrypoint.indexOf("setpriv --reuid=node"));
  });

  it("keeps web read-only nginx writable paths and postgres secrets explicitly owner-readable", () => {
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("tmpfs: [/tmp, /var/cache/nginx, /var/run]");
    expect(compose).toMatch(/source: postgres_password[\s\S]*mode: 0400/);
    const postgresService = compose.match(/ {2}postgres:[\s\S]*?(?=\n {2}migrate:)/)?.[0] ?? "";
    expect(postgresService).not.toContain("cap_drop: [ALL]");
    expect(postgresService).not.toContain("<<: *node-hardening");
    const nodeHardening = compose.match(/x-node-hardening:[\s\S]*?(?=\nx-database-env:)/)?.[0] ?? "";
    expect(nodeHardening).not.toContain("cap_drop: [ALL]");
  });
});
