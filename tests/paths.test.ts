import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ToolError } from "../src/errors.js";
import { resolveInRoots } from "../src/paths.js";
import { createTmpDir } from "./helpers/tmp.js";

const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup()));
});

/** A fresh workspace directory registered for cleanup. */
async function workspace(): Promise<string> {
  const dir = await createTmpDir("acp-paths");
  cleanups.push(dir.cleanup);
  return dir.path;
}

describe("resolveInRoots", () => {
  it("resolves a relative path against the session cwd", async () => {
    const root = await workspace();

    expect(await resolveInRoots("src/index.ts", { cwd: root, roots: [root] })).toBe(
      join(root, "src/index.ts"),
    );
  });

  it("rejects a path that is not a non-empty string", async () => {
    const root = await workspace();

    await expect(resolveInRoots(42, { cwd: root, roots: [root] })).rejects.toThrow(ToolError);
    await expect(resolveInRoots("   ", { cwd: root, roots: [root] })).rejects.toThrow(
      /non-empty `path`/,
    );
  });

  it("refuses a path outside the workspace", async () => {
    const root = await workspace();

    await expect(resolveInRoots("/etc/passwd", { cwd: root, roots: [root] })).rejects.toThrow(
      /outside the session workspace/,
    );
  });

  it("accepts the filesystem root as a workspace root", async () => {
    // `resolve` strips trailing separators from every root but `/`, so this is
    // the one root whose spelling still ends in a separator.
    expect(await resolveInRoots("etc/hosts", { cwd: "/", roots: ["/"] })).toBe("/etc/hosts");
  });

  it("resolves a path whose root does not exist yet", async () => {
    const root = join(await workspace(), "not-created");

    // A root that `realpath` cannot read falls back to its lexical spelling.
    expect(await resolveInRoots("file.txt", { cwd: root, roots: [root] })).toBe(join(root, "file.txt"));
  });

  it("keeps a file that does not exist yet inside the workspace", async () => {
    const root = await workspace();

    expect(await resolveInRoots("brand/new.ts", { cwd: root, roots: [root] })).toBe(
      join(root, "brand/new.ts"),
    );
  });

  it("reports a path that is not a directory rather than treating it as missing", async () => {
    const root = await workspace();
    await writeFile(join(root, "plain.txt"), "not a directory", "utf8");

    // ENOTDIR, not ENOENT: the model asked for a child of a file, and silently
    // accepting that would hide a mistake it should correct.
    await expect(
      resolveInRoots("plain.txt/child", { cwd: root, roots: [root] }),
    ).rejects.toThrow();
  });

  it("refuses a symlink that escapes the workspace", async () => {
    const root = await workspace();
    const outside = await workspace();
    await mkdir(join(outside, "nested"), { recursive: true });
    await writeFile(join(outside, "nested", "secret.txt"), "secret", "utf8");
    await symlink(outside, join(root, "escape"));

    // Lexically inside, physically outside: only the real path catches this.
    await expect(resolveInRoots("escape/nested/secret.txt", { cwd: root, roots: [root] })).rejects.toThrow(
      /resolves outside the session workspace/,
    );
  });
});
