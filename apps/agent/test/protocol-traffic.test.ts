import { describe, expect, it } from "vitest";
import { NapCatTrafficAccumulator, parseNapCatConnectionLine, parseNapCatTrafficLine } from "../src/traffic.js";

const inboundGroup = "2026-08-21T09:36:28.123456789Z 08-21 19:36:28 [info] 不懂问我 | 接收 <- 群聊 [测试群(200981957)] [成员(1455611500)] hello";
const outboundPrivate = "2026-08-21T09:36:31.000000000Z 08-21 19:36:31 [info] 不懂问我 | 发送 -> 私聊 [成员(1455611500)] reply";
const disconnected = "2026-08-21T09:36:32.000000000Z 08-21 19:36:32 [error] QQ | [OneBot] [WebSocket Client] 反向WebSocket (wss://example.test/ws?token=secret) 连接意外关闭";
const reconnecting = "2026-08-21T09:36:33.000000000Z 08-21 19:36:33 [error] QQ | [OneBot] [WebSocket Client] 在 5 秒后尝试重新连接";

describe("NapCat protocol traffic telemetry", () => {
  it("parses message direction and scope without retaining message content", () => {
    expect(parseNapCatTrafficLine(inboundGroup)).toEqual({
      id: expect.stringMatching(/^[a-f0-9]{64}$/),
      at: "2026-08-21T09:36:28.123Z",
      direction: "inbound",
      scope: "group",
      bytes: expect.any(Number),
    });
    expect(parseNapCatTrafficLine(outboundPrivate)).toMatchObject({
      at: "2026-08-21T09:36:31.000Z",
      direction: "outbound",
      scope: "private",
    });
    expect(JSON.stringify(parseNapCatTrafficLine(inboundGroup))).not.toContain("hello");
    expect(JSON.stringify(parseNapCatTrafficLine(inboundGroup))).not.toContain("测试群");
  });

  it("ignores login, QR and non-message runtime logs", () => {
    expect(parseNapCatTrafficLine("2026-08-21T09:36:00.000000000Z 08-21 19:36:00 [warn] 二维码已保存到 /app/napcat/cache/qrcode.png")).toBeNull();
    expect(parseNapCatTrafficLine("2026-08-21T09:36:00.000000000Z 08-21 19:36:00 [info] [ServerTime] 时间同步完成")).toBeNull();
  });

  it("extracts connection lifecycle without retaining targets or credentials", () => {
    expect(parseNapCatConnectionLine(disconnected)).toMatchObject({
      id: expect.stringMatching(/^[a-f0-9]{64}$/),
      at: "2026-08-21T09:36:32.000Z",
      transport: "websocket-client",
      status: "disconnected",
    });
    expect(parseNapCatConnectionLine(reconnecting)).toMatchObject({ status: "reconnecting" });
    expect(JSON.stringify(parseNapCatConnectionLine(disconnected))).not.toContain("example.test");
    expect(JSON.stringify(parseNapCatConnectionLine(disconnected))).not.toContain("secret");
  });

  it("deduplicates overlapping Docker log windows and builds bounded rolling telemetry", () => {
    const accumulator = new NapCatTrafficAccumulator();
    const now = new Date("2026-08-21T09:36:35.000Z").getTime();
    accumulator.ingest([inboundGroup, inboundGroup, outboundPrivate, disconnected, reconnecting], now);
    accumulator.ingest([inboundGroup], now + 5_000);

    const summary = accumulator.summary(now + 5_000);
    expect(summary).toMatchObject({
      source: "napcat.container_logs",
      privacy: "aggregate_only",
      oneMinute: { inbound: 1, outbound: 1, total: 2 },
      fiveMinutes: { inbound: 1, outbound: 1, total: 2 },
    });
    expect(summary.recent).toHaveLength(2);
    expect(summary.recentConnections).toEqual([
      expect.objectContaining({ status: "reconnecting" }),
      expect.objectContaining({ status: "disconnected" }),
    ]);
    expect(summary.buckets).toHaveLength(6);
    expect(summary.recent[0]).not.toHaveProperty("content");

    expect(accumulator.summary(now + 61_000).oneMinute.total).toBe(0);
    expect(accumulator.summary(now + 301_000).fiveMinutes.total).toBe(0);
    expect(accumulator.summary(now + 301_000).recent).toHaveLength(0);
  });
});
