import { createHash } from "node:crypto";

export type ProtocolTrafficDirection = "inbound" | "outbound";
export type ProtocolTrafficScope = "group" | "private" | "unknown";

export interface ProtocolTrafficEvent {
  id: string;
  at: string;
  direction: ProtocolTrafficDirection;
  scope: ProtocolTrafficScope;
  bytes: number;
}

export interface ProtocolConnectionEvent {
  id: string;
  at: string;
  transport: "websocket-client" | "websocket-server";
  status: "listening" | "connected" | "disconnected" | "reconnecting" | "error";
}

export interface ProtocolTrafficWindow {
  inbound: number;
  outbound: number;
  total: number;
  bytes: number;
}

export interface ProtocolTrafficSummary {
  source: "napcat.container_logs";
  privacy: "aggregate_only";
  observedAt: string;
  oneMinute: ProtocolTrafficWindow;
  fiveMinutes: ProtocolTrafficWindow;
  buckets: Array<{ startedAt: string; inbound: number; outbound: number; total: number }>;
  recent: Array<Omit<ProtocolTrafficEvent, "id">>;
  recentConnections: Array<Omit<ProtocolConnectionEvent, "id">>;
}

const dockerTimestamp = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(.+)$/;
const ansiColorStart = `${String.fromCharCode(27)}[`;
function stripAnsiColor(value: string) {
  let result = value;
  for (;;) {
    const start = result.indexOf(ansiColorStart);
    if (start < 0) return result;
    const end = result.indexOf("m", start + ansiColorStart.length);
    if (end < 0) return result;
    result = result.slice(0, start) + result.slice(end + 1);
  }
}

export function parseNapCatTrafficLine(line: string): ProtocolTrafficEvent | null {
  const matched = dockerTimestamp.exec(line.trim());
  if (!matched) return null;
  const [, rawTimestamp, message = ""] = matched;
  const inbound = message.includes("接收 <-");
  const outbound = message.includes("发送 ->");
  if (!inbound && !outbound) return null;
  const timestamp = new Date(rawTimestamp!);
  if (!Number.isFinite(timestamp.getTime())) return null;
  return {
    id: createHash("sha256").update(line).digest("hex"),
    at: timestamp.toISOString(),
    direction: inbound ? "inbound" : "outbound",
    scope: message.includes("群聊") ? "group" : message.includes("私聊") ? "private" : "unknown",
    bytes: Buffer.byteLength(message, "utf8"),
  };
}

export function parseNapCatConnectionLine(line: string): ProtocolConnectionEvent | null {
  const matched = dockerTimestamp.exec(line.trim());
  if (!matched) return null;
  const [, rawTimestamp, rawMessage = ""] = matched;
  const message = stripAnsiColor(rawMessage);
  const client = message.includes("[WebSocket Client]");
  const server = message.includes("WebSocket反向服务");
  if (!client && !server) return null;
  const timestamp = new Date(rawTimestamp!);
  if (!Number.isFinite(timestamp.getTime())) return null;
  const status = message.includes("重新连接")
    ? "reconnecting"
    : /连接意外关闭|断开|关闭/.test(message)
      ? "disconnected"
      : /连接错误|\berror\b/i.test(message)
        ? "error"
        : /连接成功|已连接/.test(message)
          ? "connected"
          : message.includes("已启动")
            ? "listening"
            : null;
  if (!status) return null;
  return {
    id: createHash("sha256").update(line).digest("hex"),
    at: timestamp.toISOString(),
    transport: client ? "websocket-client" : "websocket-server",
    status,
  };
}

export class NapCatTrafficAccumulator {
  private readonly seen = new Map<string, number>();
  private events: ProtocolTrafficEvent[] = [];
  private connections: ProtocolConnectionEvent[] = [];

  ingest(lines: string[], now = Date.now()) {
    this.prune(now);
    for (const line of lines) {
      const event = parseNapCatTrafficLine(line);
      const connection = parseNapCatConnectionLine(line);
      const parsed = event ?? connection;
      if (!parsed || this.seen.has(parsed.id)) continue;
      const at = new Date(parsed.at).getTime();
      if (at < now - 5 * 60_000 || at > now + 30_000) continue;
      this.seen.set(parsed.id, at);
      if (event) this.events.push(event);
      if (connection) this.connections.push(connection);
    }
    this.events.sort((left, right) => new Date(left.at).getTime() - new Date(right.at).getTime());
    this.connections.sort((left, right) => new Date(left.at).getTime() - new Date(right.at).getTime());
    this.prune(now);
  }

  summary(now = Date.now()): ProtocolTrafficSummary {
    this.prune(now);
    const window = (milliseconds: number): ProtocolTrafficWindow => {
      const events = this.events.filter(event => new Date(event.at).getTime() >= now - milliseconds);
      const inbound = events.filter(event => event.direction === "inbound").length;
      const outbound = events.length - inbound;
      return { inbound, outbound, total: events.length, bytes: events.reduce((sum, event) => sum + event.bytes, 0) };
    };
    const currentBucket = Math.floor(now / 10_000) * 10_000;
    const buckets = Array.from({ length: 6 }, (_, index) => {
      const startedAt = currentBucket - (5 - index) * 10_000;
      const events = this.events.filter(event => {
        const at = new Date(event.at).getTime();
        return at >= startedAt && at < startedAt + 10_000;
      });
      const inbound = events.filter(event => event.direction === "inbound").length;
      return { startedAt: new Date(startedAt).toISOString(), inbound, outbound: events.length - inbound, total: events.length };
    });
    return {
      source: "napcat.container_logs",
      privacy: "aggregate_only",
      observedAt: new Date(now).toISOString(),
      oneMinute: window(60_000),
      fiveMinutes: window(5 * 60_000),
      buckets,
      recent: this.events.slice(-40).reverse().map(event => ({ at: event.at, direction: event.direction, scope: event.scope, bytes: event.bytes })),
      recentConnections: this.connections.slice(-40).reverse().map(event => ({ at: event.at, transport: event.transport, status: event.status })),
    };
  }

  private prune(now: number) {
    const cutoff = now - 5 * 60_000;
    this.events = this.events.filter(event => new Date(event.at).getTime() >= cutoff);
    this.connections = this.connections.filter(event => new Date(event.at).getTime() >= cutoff);
    for (const [id, at] of this.seen) if (at < cutoff) this.seen.delete(id);
  }
}
