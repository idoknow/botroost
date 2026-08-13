import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileAgentJournal,
  type JournalWriter,
} from "../src/index.js";
const pathFor = async () =>
  join(await mkdtemp(join(tmpdir(), "journal-")), "journal.jsonl");
describe("journal durability and ordering", () => {
  it("completes short writes before syncing and updating memory", async () => {
    const path = await pathFor();
    const writeSizes: number[] = [];
    const journal = await FileAgentJournal.open(path, (file) => ({
      write: async (buffer, offset, length, position) => {
        const shortLength = Math.min(length, 7);
        writeSizes.push(shortLength);
        return file.write(buffer, offset, shortLength, position);
      },
      sync: () => file.sync(),
    }));

    await journal.recordReceipt("r", { durable: true });

    expect(writeSizes.length).toBeGreaterThan(1);
    expect(journal.get("r")?.receipt).toEqual({ durable: true });
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
    await journal.close();
  });

  it.each(["zero-byte write", "write error", "sync error"])(
    "poisons after %s and rejects all later records without memory updates",
    async (failure) => {
      const path = await pathFor();
      let calls = 0;
      const writerFactory = (file: JournalWriter): JournalWriter => ({
        write: async (buffer, offset, length, position) => {
          calls += 1;
          if (failure === "zero-byte write") return { bytesWritten: 0 };
          if (failure === "write error") throw new Error("write failed");
          return file.write(buffer, offset, length, position);
        },
        sync: async () => {
          if (failure === "sync error") throw new Error("sync failed");
          await file.sync();
        },
      });
      const journal = await FileAgentJournal.open(path, writerFactory);

      await expect(journal.recordReceipt("r", { n: 1 })).rejects.toThrow();
      expect(journal.get("r")).toBeUndefined();
      const callsAfterFailure = calls;
      await expect(journal.recordReceipt("later", {})).rejects.toThrow(/poisoned/);
      expect(calls).toBe(callsAfterFailure);
      expect(journal.get("later")).toBeUndefined();
      await journal.close();
    },
  );
  it("recovers versioned receipt effect result after restart", async () => {
    const path = await pathFor();
    let journal = await FileAgentJournal.open(path);
    await journal.recordReceipt("r", { op: "apply" });
    await journal.recordEffect("r", "e", { kind: "write" });
    await journal.recordResult("r", { outcome: "succeeded" });
    await journal.close();
    journal = await FileAgentJournal.open(path);
    expect(journal.get("r")).toEqual({
      receipt: { op: "apply" },
      effects: { e: { kind: "write" } },
      result: { outcome: "succeeded" },
    });
    expect(await readFile(path, "utf8")).toMatch(/^\{"version":1,/);
    await journal.close();
  });
  it("enforces receipt before effect and effect before result", async () => {
    const journal = await FileAgentJournal.open(await pathFor());
    await expect(journal.recordEffect("missing", "e", {})).rejects.toThrow(
      /receipt/,
    );
    await journal.recordReceipt("r", {});
    await expect(journal.recordResult("r", {})).rejects.toThrow(/effect/);
    await journal.close();
  });
  it("deduplicates identical IDs and rejects changed payloads", async () => {
    const journal = await FileAgentJournal.open(await pathFor());
    await journal.recordReceipt("r", { n: 1 });
    await journal.recordReceipt("r", { n: 1 });
    await expect(journal.recordReceipt("r", { n: 2 })).rejects.toThrow(
      /different payload/,
    );
    await journal.recordEffect("r", "e", { n: 1 });
    await expect(journal.recordEffect("r", "e", { n: 2 })).rejects.toThrow(
      /different payload/,
    );
    await journal.close();
  });
  it("serializes concurrent writes on one instance", async () => {
    const journal = await FileAgentJournal.open(await pathFor());
    await journal.recordReceipt("r", {});
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        journal.recordEffect("r", `e${i}`, { i }),
      ),
    );
    expect(Object.keys(journal.get("r")!.effects)).toHaveLength(20);
    await journal.close();
  });
  it("holds an exclusive writer lock and releases it on close", async () => {
    const path = await pathFor();
    const first = await FileAgentJournal.open(path);
    await expect(FileAgentJournal.open(path)).rejects.toThrow(/locked/);
    await first.close();
    const second = await FileAgentJournal.open(path);
    await second.close();
  });
  it("fails closed on an old lock directory instead of reclaiming it", async () => {
    const path = await pathFor();
    await mkdir(`${path}.lock`, { mode: 0o700 });
    await writeFile(
      `${path}.lock/owner.json`,
      JSON.stringify({ pid: 2147483647, createdAt: "2000-01-01T00:00:00.000Z" }),
    );
    await expect(FileAgentJournal.open(path)).rejects.toThrow(/locked/);
    expect(await readdir(`${path}.lock`)).toEqual(["owner.json"]);
  });
  it("rejects non-directory and symlink lock paths", async () => {
    const path = await pathFor();
    await writeFile(`${path}.lock`, "old lock");
    await expect(FileAgentJournal.open(path)).rejects.toThrow(/locked/);
    const other = await pathFor();
    await symlink(`${path}.lock`, `${other}.lock`);
    await expect(FileAgentJournal.open(other)).rejects.toThrow(/locked/);
  });
  it("does not delete foreign contents added to its lock directory", async () => {
    const path = await pathFor();
    const journal = await FileAgentJournal.open(path);
    await writeFile(`${path}.lock/foreign`, "keep");
    await expect(journal.close()).rejects.toThrow();
    expect(await readFile(`${path}.lock/foreign`, "utf8")).toBe("keep");
  });
  it("does not delete a replacement lock directory on close", async () => {
    const path = await pathFor();
    const journal = await FileAgentJournal.open(path);
    await rename(`${path}.lock`, `${path}.owned-lock`);
    await mkdir(`${path}.lock`, { mode: 0o700 });
    await writeFile(`${path}.lock/owner.json`, "foreign owner");
    await expect(journal.close()).rejects.toThrow(/ownership|lock/i);
    expect(await readFile(`${path}.lock/owner.json`, "utf8")).toBe("foreign owner");
  });
  it("fails closed for middle corruption but tolerates final torn record", async () => {
    const path = await pathFor();
    await writeFile(
      path,
      '{"version":1,"type":"receipt","receiptId":"r","data":{}}\nBAD\n{"version":1,"type":"effect","receiptId":"r","effectId":"e","data":{}}\n',
    );
    await expect(FileAgentJournal.open(path)).rejects.toThrow(/corrupt/);
    await writeFile(
      path,
      '{"version":1,"type":"receipt","receiptId":"r","data":{}}\n{torn',
    );
    const journal = await FileAgentJournal.open(path);
    expect(journal.get("r")?.receipt).toEqual({});
    await journal.recordEffect("r", "e", { recovered: true });
    await journal.close();
    const reopened = await FileAgentJournal.open(path);
    expect(reopened.get("r")?.effects.e).toEqual({ recovered: true });
    expect(await readFile(path, "utf8")).not.toContain("{torn");
    await reopened.close();
  });
  it("drops a complete final JSON record without a newline before replay", async () => {
    const path = await pathFor();
    await writeFile(
      path,
      '{"version":1,"type":"receipt","receiptId":"r","data":{}}\n' +
        '{"version":1,"type":"effect","receiptId":"r","effectId":"lost","data":{}}',
    );
    const journal = await FileAgentJournal.open(path);
    expect(journal.get("r")?.effects).toEqual({});
    await journal.recordEffect("r", "kept", {});
    await journal.close();
    const reopened = await FileAgentJournal.open(path);
    expect(reopened.get("r")?.effects).toEqual({ kept: {} });
    await reopened.close();
  });
  it.each([
    ["empty receipt ID", () => ["receipt", "", undefined] as const],
    ["empty effect receipt ID", () => ["effect", "", "e"] as const],
    ["empty effect ID", () => ["effect", "r", ""] as const],
    ["empty result receipt ID", () => ["result", "", undefined] as const],
  ])("rejects %s before writing", async (_name, make) => {
    const path = await pathFor();
    const journal = await FileAgentJournal.open(path);
    const before = await readFile(path);
    const [kind, receiptId, effectId] = make();
    const operation = kind === "receipt"
      ? journal.recordReceipt(receiptId, {})
      : kind === "effect"
        ? journal.recordEffect(receiptId, effectId!, {})
        : journal.recordResult(receiptId, {});
    await expect(operation).rejects.toThrow();
    expect(await readFile(path)).toEqual(before);
    await journal.close();
  });
  it("uses canonical JSON equality for idempotency", async () => {
    const path = await pathFor();
    const journal = await FileAgentJournal.open(path);
    await journal.recordReceipt("r", { a: 1, nested: { x: 1, y: 2 } });
    await journal.recordReceipt("r", { nested: { y: 2, x: 1 }, a: 1 });
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(1);
    await journal.close();
  });
  it.each([
    ["undefined", { value: undefined }],
    ["function", { value: () => undefined }],
    ["symbol", { value: Symbol("x") }],
    ["NaN", { value: Number.NaN }],
    ["Infinity", { value: Number.POSITIVE_INFINITY }],
    ["Date", { value: new Date("2020-01-01T00:00:00.000Z") }],
  ])("rejects non-JSON payload value %s", async (_name, payload) => {
    const journal = await FileAgentJournal.open(await pathFor());
    await expect(journal.recordReceipt("r", payload as never)).rejects.toThrow(/JSON/);
    await journal.close();
  });
  it("rejects symlinks and non-regular files and forces 0600", async () => {
    const path = await pathFor();
    const target = `${path}.target`;
    await writeFile(target, "");
    await symlink(target, path);
    await expect(FileAgentJournal.open(path)).rejects.toThrow(
      /regular|symlink/,
    );
    const real = await pathFor();
    await writeFile(real, "");
    await chmod(real, 0o644);
    const journal = await FileAgentJournal.open(real);
    expect((await lstat(real)).mode & 0o777).toBe(0o600);
    await journal.close();
  });
  it("closes the journal descriptor when replay initialization fails", async () => {
    if (process.platform !== "linux") return;
    const path = await pathFor();
    await writeFile(
      path,
      '{"version":1,"type":"effect","receiptId":"r","effectId":"e","data":{}}\n',
    );
    const countJournalDescriptors = async () => {
      const { readdir, readlink } = await import("node:fs/promises");
      const descriptors = await readdir("/proc/self/fd");
      const targets = await Promise.all(
        descriptors.map((fd) =>
          readlink(`/proc/self/fd/${fd}`).catch(() => ""),
        ),
      );
      return targets.filter((target) => target === path).length;
    };
    const before = await countJournalDescriptors();
    for (let attempt = 0; attempt < 5; attempt += 1)
      await expect(FileAgentJournal.open(path)).rejects.toThrow(/receipt/);
    expect(await countJournalDescriptors()).toBe(before);
    await expect(lstat(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects unknown schema versions and invalid replay order", async () => {
    const path = await pathFor();
    await writeFile(
      path,
      '{"version":2,"type":"receipt","receiptId":"r","data":{}}\n',
    );
    await expect(FileAgentJournal.open(path)).rejects.toThrow();
    await writeFile(
      path,
      '{"version":1,"type":"effect","receiptId":"r","effectId":"e","data":{}}\n',
    );
    await expect(FileAgentJournal.open(path)).rejects.toThrow(/receipt/);
  });
});
