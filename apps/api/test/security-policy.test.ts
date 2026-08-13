import { describe, expect, it } from "vitest";
import { LoginAttemptLimiter, parseTrustedProxy } from "../src/security-policy.js";

describe("login security policy", () => {
  it("keys failures by normalized account and IP, expires entries, and keeps the IP budget after success", () => {
    let now = 1_000;
    const limiter = new LoginAttemptLimiter({ limit: 2, ttlMs: 100, capacity: 4, now: () => now });
    limiter.recordFailure(" User@Example.COM ", "192.0.2.1");
    expect(limiter.isBlocked("user@example.com", "192.0.2.1")).toBe(false);
    limiter.recordFailure("user@example.com", "192.0.2.1");
    expect(limiter.isBlocked(" USER@example.com ", "192.0.2.1")).toBe(true);
    limiter.recordSuccess("user@example.com", "192.0.2.1");
    expect(limiter.isBlocked("user@example.com", "192.0.2.1")).toBe(true);
    expect(limiter.isBlocked("user@example.com", "192.0.2.2")).toBe(false);
    now += 101;
    expect(limiter.isBlocked("user@example.com", "192.0.2.1")).toBe(false);
  });

  it("has a hard capacity and rejects blanket trust-proxy true", () => {
    const limiter = new LoginAttemptLimiter({ limit: 1, ttlMs: 1_000, capacity: 2 });
    limiter.recordFailure("a@example.com", "192.0.2.1");
    limiter.recordFailure("b@example.com", "192.0.2.2");
    limiter.recordFailure("c@example.com", "192.0.2.3");
    expect(limiter.size).toBeLessThanOrEqual(2);
    expect(() => parseTrustedProxy("true")).toThrow(/must not be true/);
    expect(parseTrustedProxy("1")).toBe(1);
    expect(parseTrustedProxy("loopback, 10.0.0.0/8")).toEqual(["loopback", "10.0.0.0/8"]);
    expect(parseTrustedProxy(undefined)).toBe(false);
  });
});
