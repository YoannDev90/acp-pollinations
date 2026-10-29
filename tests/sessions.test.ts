import { readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  MAX_PERSISTED_SESSIONS,
  createSessionStore,
} from "../sessions.js";
import type { PersistedSession } from "../sessions.js";
import { createTmpDir } from "./helpers/tmp.js";

const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup()));
});

/** A scratch store directory, removed after the run. */
async function withStoreDir(): Promise<string> {
  const dir = await createTmpDir("acp-sessions");
  cleanups.push(dir.cleanup);
  return join(dir.path, "sessions");
}

function record(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    id: "sess_abc123",
    cwd: "/workspace",
    roots: ["/workspace"],
    model: "test-model",
    allowedTools: [],
    messageCounter: 2,
    lastPromptTokens: 12_345,
    history: [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
        ],
      },
      { role: "tool", content: "file.ts", tool_call_id: "call_1" },
    ],
    ...overrides,
  };
}

describe("createSessionStore", () => {
  it("round-trips a record through disk", async () => {
    const store = createSessionStore(await withStoreDir());
    const original = record();

    await store.save(original);
    const loaded = await store.load(original.id);

    expect(loaded).toEqual(original);
  });

  it("restores a record from a fresh store, as a restarted process would", async () => {
    const dir = await withStoreDir();
    const original = record({ model: "a-picked-model" });

    await createSessionStore(dir).save(original);
    // New instance, same directory: this is what a relaunched agent sees.
    const reloaded = await createSessionStore(dir).load(original.id);

    expect(reloaded?.model).toBe("a-picked-model");
  });

  it("returns null for an unknown id", async () => {
    const store = createSessionStore(await withStoreDir());
    expect(await store.load("sess_missing")).toBeNull();
  });

  it("refuses an id that would escape the store directory", async () => {
    const dir = await withStoreDir();
    const store = createSessionStore(dir);

    await store.save(record({ id: "sess_victim" }));
    // Written by hand so the read, not the write, is what must refuse it.
    await writeFile(join(dir, "..", "secret.json"), "{}", "utf8");

    expect(await store.load("../../secret")).toBeNull();
    expect(await store.load("..")).toBeNull();
    expect(await store.load("sess_victim/../../etc/passwd")).toBeNull();
  });

  it("returns null for malformed JSON", async () => {
    const dir = await withStoreDir();
    await createSessionStore(dir).save(record());
    await writeFile(join(dir, "sess_abc123.json"), "{ not json", "utf8");

    expect(await createSessionStore(dir).load("sess_abc123")).toBeNull();
  });

  it("returns null for an unknown schema version", async () => {
    const dir = await withStoreDir();
    await createSessionStore(dir).save(record());
    const path = join(dir, "sess_abc123.json");
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...parsed, version: 999 }), "utf8");

    expect(await createSessionStore(dir).load("sess_abc123")).toBeNull();
  });

  it("rejects a transcript whose entries are not well-formed", async () => {
    const dir = await withStoreDir();
    const store = createSessionStore(dir);
    // Establish the directory, then write the malformed records directly.
    await store.save(record({ id: "sess_seed" }));

    await writeFile(
      join(dir, "sess_bad_role.json"),
      JSON.stringify({
        ...record({ id: "sess_bad_role" }),
        history: [{ role: "narrator", content: "hi" }],
      }),
      "utf8",
    );
    expect(await store.load("sess_bad_role")).toBeNull();

    await writeFile(
      join(dir, "sess_bad_content.json"),
      JSON.stringify({ ...record({ id: "sess_bad_content" }), history: [{ role: "user", content: 42 }] }),
      "utf8",
    );
    expect(await store.load("sess_bad_content")).toBeNull();
  });

  it("leaves no temporary file behind", async () => {
    const dir = await withStoreDir();
    await createSessionStore(dir).save(record());

    expect(await readdir(dir)).toEqual(["sess_abc123.json"]);
  });

  it("drops the oldest records past the cap", async () => {
    const dir = await withStoreDir();
    const store = createSessionStore(dir);

    for (let index = 0; index < MAX_PERSISTED_SESSIONS + 2; index += 1) {
      const id = `sess_${String(index).padStart(4, "0")}`;
      await store.save(record({ id }));
      // Force a distinct mtime so "oldest" is not a tie.
      const path = join(dir, `${id}.json`);
      const second = index;
      await utimes(path, second, second);
    }

    const remaining = await readdir(dir);
    expect(remaining).toHaveLength(MAX_PERSISTED_SESSIONS);
    // The first two written are the ones that should have aged out.
    expect(remaining).not.toContain("sess_0000.json");
    expect(remaining).not.toContain("sess_0001.json");
    expect(remaining).toContain(`sess_${String(MAX_PERSISTED_SESSIONS + 1).padStart(4, "0")}.json`);
  });

  it("never touches disk without a directory", async () => {
    const store = createSessionStore(undefined);

    await expect(store.save(record())).resolves.toBeUndefined();
    expect(await store.load("sess_abc123")).toBeNull();
  });

  it("propagates a write failure so the caller can decide", async () => {
    const dir = await createTmpDir("acp-sessions-blocked");
    cleanups.push(dir.cleanup);

    // A plain file where a directory is expected: `mkdir` fails with ENOTDIR.
    await writeFile(join(dir.path, "blocked"), "not a directory", "utf8");
    const store = createSessionStore(join(dir.path, "blocked", "sessions"));

    await expect(store.save(record())).rejects.toThrow();
  });

  it("removes a record and reports whether one existed", async () => {
    const store = createSessionStore(await withStoreDir());
    await store.save(record());

    expect(await store.remove(record().id)).toBe(true);
    expect(await store.remove(record().id)).toBe(false);
    expect(await store.load(record().id)).toBeNull();
  });

  it("lists sessions newest first", async () => {
    const dir = await withStoreDir();
    const store = createSessionStore(dir);

    for (const [index, id] of ["sess_old", "sess_mid", "sess_new"].entries()) {
      await store.save(record({ id }));
      await utimes(join(dir, `${id}.json`), 100 + index, 100 + index);
    }

    const { sessions, nextCursor } = await store.list();

    expect(sessions.map((entry) => entry.id)).toEqual(["sess_new", "sess_mid", "sess_old"]);
    expect(nextCursor).toBeUndefined();
    expect(sessions[0]?.updatedAt).toBe(new Date(102_000).toISOString());
  });

  it("narrows the listing to one workspace", async () => {
    const store = createSessionStore(await withStoreDir());
    await store.save(record({ id: "sess_here", cwd: "/workspace", roots: ["/workspace"] }));
    await store.save(record({ id: "sess_there", cwd: "/elsewhere", roots: ["/elsewhere"] }));

    const { sessions } = await store.list({ cwd: "/workspace" });
    expect(sessions.map((entry) => entry.id)).toEqual(["sess_here"]);
  });

  it("pages the listing with an opaque cursor", async () => {
    const dir = await withStoreDir();
    const store = createSessionStore(dir);

    for (let index = 0; index < 3; index += 1) {
      const id = `sess_page_${index}`;
      await store.save(record({ id }));
      await utimes(join(dir, `${id}.json`), 100 + index, 100 + index);
    }

    const first = await store.list({ limit: 2 });
    expect(first.sessions).toHaveLength(2);
    expect(first.nextCursor).toBe("2");

    const second = await store.list({ limit: 2, cursor: first.nextCursor });
    expect(second.sessions).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    // Ordering holds across the page boundary.
    expect([...first.sessions, ...second.sessions].map((entry) => entry.id)).toEqual([
      "sess_page_2",
      "sess_page_1",
      "sess_page_0",
    ]);
  });

  it("loads a record written before lastPromptTokens existed", async () => {
    const dir = await withStoreDir();
    const store = createSessionStore(dir);
    await store.save(record());

    const path = join(dir, "sess_abc123.json");
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    delete parsed.lastPromptTokens;
    await writeFile(path, JSON.stringify(parsed), "utf8");

    const loaded = await store.load("sess_abc123");
    expect(loaded?.lastPromptTokens).toBe(0);
    expect(loaded?.history).toHaveLength(4);
  });
});
