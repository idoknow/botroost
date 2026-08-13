import type { FastifyServerOptions } from "fastify";

type Entry = { count: number; resetAt: number };
export class LoginAttemptLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly limit: number;
  private readonly ttlMs: number;
  private readonly capacity: number;
  private readonly now: () => number;
  constructor(options: { limit?: number; ttlMs?: number; capacity?: number; now?: () => number } = {}) {
    this.limit = options.limit ?? 10;
    this.ttlMs = options.ttlMs ?? 60_000;
    this.capacity = options.capacity ?? 10_000;
    this.now = options.now ?? Date.now;
  }
  private key(email: string, ip: string) { return `${email.trim().toLowerCase()}\0${ip}`; }
  private prune(now: number) { for (const [key, value] of this.entries) if (value.resetAt <= now) this.entries.delete(key); }
  isBlocked(email: string, ip: string) {
    const now = this.now(); this.prune(now);
    return (this.entries.get(this.key(email, ip))?.count ?? 0) >= this.limit;
  }
  recordFailure(email: string, ip: string) {
    const now = this.now(); this.prune(now);
    const key = this.key(email, ip);
    const current = this.entries.get(key);
    if (current) current.count += 1;
    else {
      while (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value as string);
      this.entries.set(key, { count: 1, resetAt: now + this.ttlMs });
    }
  }
  recordSuccess(email?: string, ip?: string) { void email; void ip; /* Failure budgets intentionally survive success. */ }
  get size() { this.prune(this.now()); return this.entries.size; }
}

export function parseTrustedProxy(value: string | undefined): FastifyServerOptions["trustProxy"] {
  if (!value || value === "false") return false;
  if (value === "true") throw new Error("TRUST_PROXY must not be true; configure trusted hop count or CIDRs");
  if (/^[1-9]\d*$/.test(value)) return Number(value);
  const addresses = value.split(",").map(item => item.trim()).filter(Boolean);
  if (!addresses.length) return false;
  return addresses;
}
