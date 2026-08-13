import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rmdir,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
type JsonValue = null | boolean | number | string | JsonValue[] | Json;
type Json = { [key: string]: JsonValue };
export interface JournalWriter {
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
}

type JournalWriterFactory = (file: FileHandle) => JournalWriter;

export interface JournalEntry {
  receipt?: Json;
  effects: Record<string, Json>;
  result?: Json;
}
const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);
const jsonObject: z.ZodType<Json> = z.record(z.string(), jsonValue);
const EventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    version: z.literal(1),
    type: z.literal("receipt"),
    receiptId: z.string().min(1),
    data: jsonObject,
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal("effect"),
    receiptId: z.string().min(1),
    effectId: z.string().min(1),
    data: jsonObject,
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal("result"),
    receiptId: z.string().min(1),
    data: jsonObject,
  }),
]);
type Event = z.infer<typeof EventSchema>;
const canonicalize = (value: JsonValue): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key]!)}`)
    .join(",")}}`;
};
const parseJson = (value: unknown): Json => {
  try {
    return jsonObject.parse(value);
  } catch (error) {
    throw new Error("payload must be strict JSON", { cause: error });
  }
};
const equal = (left: Json, right: Json): boolean =>
  canonicalize(left) === canonicalize(right);
export class FileAgentJournal {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private poisoned = false;
  private constructor(
    private readonly path: string,
    private readonly lockPath: string,
    private readonly lockOwner: string,
    private readonly file: FileHandle,
    private readonly writer: JournalWriter,
    private readonly entries: Map<string, JournalEntry>,
  ) {}
  static async open(
    path: string,
    writerFactory: JournalWriterFactory = (file) => file,
  ): Promise<FileAgentJournal> {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });
    const lockPath = `${path}.lock`;
    const lockOwnerPath = `${lockPath}/owner.json`;
    const lockOwner = JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
      nonce: crypto.randomUUID(),
    });
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(`journal is locked: ${path}`, { cause: error });
      throw error;
    }
    const releaseOwnedLock = async (): Promise<void> => {
      let current: string;
      try {
        current = await readFile(lockOwnerPath, "utf8");
      } catch (error) {
        throw new Error("journal lock ownership cannot be verified", { cause: error });
      }
      if (current !== lockOwner)
        throw new Error("journal lock ownership changed");
      await unlink(lockOwnerPath);
      await rmdir(lockPath);
      const parent = await open(directory, constants.O_RDONLY);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    };
    let file: FileHandle | undefined;
    try {
      await writeFile(lockOwnerPath, lockOwner, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const lockDirectory = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await lockDirectory.sync();
      } finally {
        await lockDirectory.close();
      }
      let created = false;
      try {
        await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") created = true;
        else throw error;
      }
      if (!created) {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error("journal must be a regular non-symlink file");
      }
      file = await open(
        path,
        constants.O_CREAT |
          constants.O_RDWR |
          constants.O_APPEND |
          constants.O_NOFOLLOW,
        0o600,
      );
      await chmod(path, 0o600);
      if (created) {
        const parent = await open(directory, constants.O_RDONLY);
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      }
      const bytes = await file.readFile();
      const hasFinalNewline = bytes.length === 0 || bytes.at(-1) === 0x0a;
      if (!hasFinalNewline) {
        const boundary = bytes.lastIndexOf(0x0a) + 1;
        await file.truncate(boundary);
        await file.sync();
      }
      const replayBytes = hasFinalNewline
        ? bytes
        : bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1);
      const text = replayBytes.toString("utf8");
      const entries = new Map<string, JournalEntry>();
      const lines = text === "" ? [] : text.split("\n");
      if (text.endsWith("\n")) lines.pop();
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (!line) throw new Error(`corrupt journal record ${index + 1}`);
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch (error) {
          if (index === lines.length - 1 && !hasFinalNewline) break;
          throw new Error(`corrupt journal record ${index + 1}`, {
            cause: error,
          });
        }
        try {
          FileAgentJournal.apply(entries, EventSchema.parse(raw));
        } catch (error) {
          throw new Error(
            `corrupt journal record ${index + 1}: ${(error as Error).message}`,
            { cause: error },
          );
        }
      }
      return new FileAgentJournal(
        path,
        lockPath,
        lockOwner,
        file,
        writerFactory(file),
        entries,
      );
    } catch (error) {
      await file?.close().catch(() => undefined);
      await releaseOwnedLock().catch(() => undefined);
      throw error;
    }
  }
  private static apply(entries: Map<string, JournalEntry>, event: Event): void {
    const entry = entries.get(event.receiptId) ?? { effects: {} };
    if (event.type === "receipt") {
      if (entry.receipt && !equal(entry.receipt, event.data))
        throw new Error("receipt ID has different payload");
      entry.receipt ??= event.data;
    } else if (event.type === "effect") {
      if (!entry.receipt) throw new Error("receipt must precede effect");
      const existing = entry.effects[event.effectId];
      if (existing && !equal(existing, event.data))
        throw new Error("effect ID has different payload");
      entry.effects[event.effectId] ??= event.data;
    } else {
      if (!entry.receipt) throw new Error("receipt must precede result");
      if (Object.keys(entry.effects).length === 0)
        throw new Error("effect must precede result");
      if (entry.result && !equal(entry.result, event.data))
        throw new Error("result ID has different payload");
      entry.result ??= event.data;
    }
    entries.set(event.receiptId, entry);
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("journal is closed"));
    if (this.poisoned) return Promise.reject(new Error("journal is poisoned"));
    const run = (): Promise<T> =>
      this.poisoned
        ? Promise.reject(new Error("journal is poisoned"))
        : operation();
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private async append(candidate: Event): Promise<void> {
    const event = EventSchema.parse(candidate);
    const copy = structuredClone(this.entries);
    FileAgentJournal.apply(copy, event);
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await this.writer.write(
          bytes,
          offset,
          bytes.length - offset,
          null,
        );
        if (bytesWritten <= 0) throw new Error("journal write made no progress");
        offset += bytesWritten;
      }
      await this.writer.sync();
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
    this.entries.clear();
    for (const [key, value] of copy) this.entries.set(key, value);
  }
  recordReceipt(receiptId: string, data: Json): Promise<void> {
    return this.serialize(async () => {
      data = parseJson(data);
      const existing = this.entries.get(receiptId)?.receipt;
      if (existing) {
        if (!equal(existing, data))
          throw new Error("receipt ID has different payload");
        return;
      }
      await this.append({ version: 1, type: "receipt", receiptId, data });
    });
  }
  recordEffect(receiptId: string, effectId: string, data: Json): Promise<void> {
    return this.serialize(async () => {
      data = parseJson(data);
      const existing = this.entries.get(receiptId)?.effects[effectId];
      if (existing) {
        if (!equal(existing, data))
          throw new Error("effect ID has different payload");
        return;
      }
      await this.append({
        version: 1,
        type: "effect",
        receiptId,
        effectId,
        data,
      });
    });
  }
  recordResult(receiptId: string, data: Json): Promise<void> {
    return this.serialize(async () => {
      data = parseJson(data);
      const existing = this.entries.get(receiptId)?.result;
      if (existing) {
        if (!equal(existing, data))
          throw new Error("result ID has different payload");
        return;
      }
      await this.append({ version: 1, type: "result", receiptId, data });
    });
  }
  get(id: string): JournalEntry | undefined {
    const entry = this.entries.get(id);
    return entry ? structuredClone(entry) : undefined;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    let closeError: unknown;
    try {
      await this.file.close();
    } catch (error) {
      closeError = error;
    }
    const ownerPath = `${this.lockPath}/owner.json`;
    let current: string;
    try {
      current = await readFile(ownerPath, "utf8");
    } catch (error) {
      throw new Error("journal lock ownership cannot be verified", { cause: error });
    }
    if (current !== this.lockOwner)
      throw new Error("journal lock ownership changed");
    await unlink(ownerPath);
    await rmdir(this.lockPath);
    if (closeError) throw closeError;
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
