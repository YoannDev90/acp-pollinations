import { chmod, mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  MAX_PERSISTED_SESSIONS,
  SESSION_RECORD_VERSION,
  createSessionStore,
} from "../src/sessions/index.js";
import type { PersistedSession } from "../src/sessions/index.js";
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

  it("rejects a record that fails any schema check", async () => {
    const dir = await withStoreDir();
    const store = createSessionStore(dir);
    // The directory must exist before the malformed records land in it.
    await store.save(record({ id: "sess_seed" }));

    /** Writes `body` as a session file; every case is a fresh record. */
    const write = async (id: string, body: Record<string, unknown>): Promise<void> => {
      await writeFile(
        join(dir, `${id}.json`),
        JSON.stringify({ version: SESSION_RECORD_VERSION, ...record({ id }), ...body }),
        "utf8",
      );
      expect(await store.load(id)).toBeNull();
    };

    // Not an object at all.
    await writeFile(join(dir, "sess_scalar.json"), JSON.stringify(42), "utf8");
    expect(await store.load("sess_scalar")).toBeNull();

    await write("sess_bad_id", { id: "../../etc/passwd" });
    await write("sess_empty_cwd", { cwd: "" });
    await write("sess_empty_model", { model: "" });
    // `roots` must be a non-empty array of strings.
    await write("sess_roots_scalar", { roots: "nope" });
    await write("sess_roots_empty", { roots: [] });
    await write("sess_roots_item", { roots: [42] });
    await write("sess_history_scalar", { history: "nope" });
    await write("sess_history_item", { history: [42] });
    await write("sess_bad_role", { history: [{ role: "narrator", content: "hi" }] });
    await write("sess_bad_content", { history: [{ role: "user", content: 42 }] });
    // `tool_calls` must be an array of well-formed calls; `tool_call_id` and
    // `reasoning_content` must be strings when present.
    await write("sess_calls_scalar", {
      history: [{ role: "assistant", content: null, tool_calls: "nope" }],
    });
    await write("sess_call_scalar", {
      history: [{ role: "assistant", content: null, tool_calls: [null] }],
    });
    await write("sess_call_fields", {
      history: [{ role: "assistant", content: null, tool_calls: [{ id: "call_1" }] }],
    });
    await write("sess_call_bad", {
      history: [{ role: "assistant", content: null, tool_calls: [{}] }],
    });
    await write("sess_bad_tool_id", { history: [{ role: "tool", content: "x", tool_call_id: 42 }] });
    await write("sess_bad_reasoning", {
      history: [{ role: "assistant", content: "x", reasoning_content: 42 }],
    });
  });

  it("keeps optional fields optional and clamps the numeric ones", async () => {
    const dir = await withStoreDir();
    const store = createSessionStore(dir);
    await store.save(record({ id: "sess_seed" }));

    const full = record();
    await writeFile(
      join(dir, "sess_optional.json"),
      JSON.stringify({
        version: SESSION_RECORD_VERSION,
        ...full,
        id: "sess_optional",
        allowedTools: "not-an-array",
        messageCounter: "two",
        lastPromptTokens: -5,
        title: "",
        reasoningLevel: "",
        mode: "",
      }),
      "utf8",
    );

    const loaded = await store.load("sess_optional");
    // Absent or hostile optionals degrade to their defaults instead of
    // failing the load: the transcript itself is intact.
    expect(loaded?.allowedTools).toEqual([]);
    expect(loaded?.messageCounter).toBe(0);
    expect(loaded?.lastPromptTokens).toBe(0);
    expect(loaded?.title).toBeUndefined();
    expect(loaded?.reasoningLevel).toBeUndefined();
    expect(loaded?.mode).toBeUndefined();
    // An empty `tool_calls` array is dropped rather than kept as a no-op.
    expect(loaded?.history).toEqual(full.history);
  });

  it("drops an empty tool_calls array instead of keeping it", async () => {
    const dir = await withStoreDir();
    const store = createSessionStore(dir);
    await store.save(record({ id: "sess_seed" }));

    await writeFile(
      join(dir, "sess_no_calls.json"),
      JSON.stringify({
        version: SESSION_RECORD_VERSION,
        ...record({ id: "sess_no_calls" }),
        history: [{ role: "assistant", content: "hi", tool_calls: [] }],
      }),
      "utf8",
    );

    const loaded = await store.load("sess_no_calls");
    expect(loaded?.history[0]).toEqual({ role: "assistant", content: "hi" });
  });

  it("keeps the descriptive fields and reasoning when they are set", async () => {
    const dir = await withStoreDir();
    const store = createSessionStore(dir);
    await store.save(
      record({
        id: "sess_described",
        title: "Fix the parser",
        reasoningLevel: "high",
        mode: "plan",
        history: [
          { role: "system", content: "system prompt" },
          { role: "assistant", content: "hi", reasoning_content: null },
        ],
      }),
    );

    const loaded = await store.load("sess_described");
    expect(loaded?.title).toBe("Fix the parser");
    expect(loaded?.reasoningLevel).toBe("high");
    expect(loaded?.mode).toBe("plan");
    expect(loaded?.history[1]).toEqual({
      role: "assistant",
      content: "hi",
      reasoning_content: null,
    });
  });

  it("gives up pruning when the directory cannot be listed", async () => {
    if (process.getuid?.() === 0) return; // root ignores the mode bits
    const dir = await withStoreDir();
    await mkdir(dir, { recursive: true });
    // Write and execute but no read: saves still land, the listing does not.
    await chmod(dir, 0o333);

    try {
      const store = createSessionStore(dir);
      // The save itself succeeds; only `prune`'s readdir fails, and that must
      // not take the save down with it.
      await expect(store.save(record())).resolves.toBeUndefined();
    } finally {
      await chmod(dir, 0o755);
    }
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
    expect(await store.remove("sess_abc123")).toBe(false);
    expect(await store.list()).toEqual({ sessions: [] });
  });

  it("ignores an unsafe id on write and delete", async () => {
    const dir = await withStoreDir();
    const store = createSessionStore(dir);
    await store.save(record({ id: "sess_seed" }));

    // A traversal id must not create a file outside the store, nor delete one.
    await expect(store.save(record({ id: "../escaped" }))).resolves.toBeUndefined();
    expect(await store.remove("../escaped")).toBe(false);
    expect(await readdir(dir)).toEqual(["sess_seed.json"]);
  });

  it("lists nothing when the directory was never created", async () => {
    const store = createSessionStore(await withStoreDir());

    expect(await store.list()).toEqual({ sessions: [] });
  });

  it("skips files that are not session records", async () => {
    const dir = await withStoreDir();
    const store = createSessionStore(dir);
    await store.save(record({ id: "sess_real" }));
    // A stray text file and a corrupt record are both unlistable.
    await writeFile(join(dir, "notes.txt"), "scratch", "utf8");
    await writeFile(join(dir, "sess_corrupt.json"), "{ not json", "utf8");

    const { sessions } = await store.list();
    expect(sessions.map((entry) => entry.id)).toEqual(["sess_real"]);
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
