import { describe, expect, it } from "vitest";
import { InMemoryDatabase } from "../src/index.js";

describe("cross-workspace shared node assignments", () => {
  it("allows endpoints to use only nodes explicitly granted to their workspace", async () => {
    const db = new InMemoryDatabase();
    const owner = db.createWorkspace("owner");
    const consumer = db.createWorkspace("consumer");
    const node = db.createNode(owner.id, "shared");
    expect(() => db.createEndpoint(consumer.id, "unauthorized", "fake", node.id)).toThrow();
    await db.setSharedNodePoolAccess(node.id, true, {}, "platform-owner");
    await db.grantSharedNode(consumer.id, node.id, "platform-owner");
    expect((await db.createEndpoint(consumer.id, "allowed", "fake", node.id)).node?.id).toBe(node.id);
  });
});
