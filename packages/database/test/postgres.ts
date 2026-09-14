import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export async function waitForPostgres(container: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      // The image's temporary init server accepts Unix sockets but disables TCP.
      execFileSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "botroost"], {
        stdio: "pipe", timeout: Math.min(5_000, Math.max(1, deadline - Date.now())),
      });
      return;
    } catch (error) {
      lastError = error;
      await delay(Math.min(250, Math.max(0, deadline - Date.now())));
    }
  }
  throw new Error(`PostgreSQL container ${container} was not ready over TCP within ${timeoutMs}ms`, { cause: lastError });
}
