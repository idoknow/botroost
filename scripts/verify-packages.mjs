import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packagesDirectory = join(root, "packages");
const packageDirectories = (await readdir(packagesDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(packagesDirectory, entry.name))
  .sort();
const temporaryDirectory = await mkdtemp(join(tmpdir(), "botroost-packs-"));

try {
  for (const packageDirectory of packageDirectories) {
    const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
    const packedJson = execFileSync(
      "pnpm",
      ["pack", "--json", "--pack-destination", temporaryDirectory],
      { cwd: packageDirectory, encoding: "utf8" },
    );
    const parsed = JSON.parse(packedJson);
    const packed = Array.isArray(parsed) ? parsed[0] : parsed;
    const files = packed.files.map(({ path }) => path).sort();
    for (const required of ["dist/index.js", "dist/index.d.ts"]) {
      if (!files.includes(required)) throw new Error(`${manifest.name}: missing ${required}`);
    }
    const forbidden = files.filter(
      (path) => path.startsWith("src/") || path.startsWith("test/") || path.endsWith(".test.ts"),
    );
    if (forbidden.length > 0) {
      throw new Error(`${manifest.name}: forbidden packed files: ${forbidden.join(", ")}`);
    }
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const imported = await import(${JSON.stringify(manifest.name)}); if (Object.keys(imported).length === 0) throw new Error("empty exports")`,
      ],
      { cwd: packageDirectory, stdio: "pipe" },
    );
    console.log(`${manifest.name}: ${files.length} files; exports smoke passed`);
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
