import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { waitForPostgres } from "./postgres.js";

it("does not accept the temporary socket-only initialization server as ready", async () => {
  const container = `botroost-readiness-${process.pid}-${Date.now()}`;
  const directory = await mkdtemp(join(tmpdir(), "botroost-readiness-"));
  await chmod(directory, 0o755);
  await writeFile(join(directory, "hold.sh"), "#!/bin/sh\ntouch /tmp/init-pending\nwhile [ ! -f /tmp/init-release ]; do sleep 0.1; done\n", { mode: 0o644 });
  const docker = (...args: string[]) => execFileSync("docker", args, { timeout: 10_000 }).toString().trim();
  let readiness: Promise<void> | undefined;
  try {
    docker("run", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=botroost", "-v", `${directory}/hold.sh:/docker-entrypoint-initdb.d/hold.sh:ro`, "postgres:16-alpine");
    await expect.poll(() => docker("exec", container, "sh", "-c", "test -f /tmp/init-pending && echo pending || true"), { timeout: 60_000 }).toBe("pending");
    expect(docker("exec", container, "pg_isready", "-U", "postgres")).toContain("accepting connections");
    expect(() => docker("exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres")).toThrow();
    console.log("Temporary initialization server accepts Unix socket connections but rejects TCP");
    let ready = false;
    readiness = waitForPostgres(container).then(() => { ready = true; });
    await delay(500);
    expect(ready, "readiness must wait until initialization finishes and the final TCP server starts").toBe(false);
    docker("exec", container, "touch", "/tmp/init-release");
    await readiness;
    expect(docker("exec", container, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "botroost", "-Atc", "SELECT 1")).toBe("1");
    console.log(docker("logs", container));
  } finally {
    try { docker("exec", container, "touch", "/tmp/init-release"); await readiness; }
    finally { docker("rm", "-f", container); await rm(directory, { recursive: true, force: true }); }
  }
}, 90_000);

it("fails explicitly when PostgreSQL never becomes ready", async () => {
  await expect(waitForPostgres(`botroost-missing-${process.pid}`, 1)).rejects.toThrow(/PostgreSQL.*ready/);
});
