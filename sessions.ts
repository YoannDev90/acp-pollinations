import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { LlmMessage, LlmRole, LlmToolCall } from "./llm.js";

/**
 * On-disk schema version, bumped whenever the record shape changes.
 *
 * An unknown version is treated as "no such session" rather than migrated:
 * a coding agent's history is cheap to rebuild and expensive to get subtly
 * wrong, so a stale file should degrade to a fresh thread.
 */
export const SESSION_RECORD_VERSION = 1;

/** Sessions kept on disk; the oldest records are dropped past this count. */
export const MAX_PERSISTED_SESSIONS = 200;

/** A session as written to disk — everything needed to rebuild it. */
export type PersistedSession = {
  id: string;
  cwd: string;
  roots: string[];
  model: string;
  allowedTools: string[];
  messageCounter: number;
  /**
   * Prompt tokens of the session's last model request.
   *
   * Recorded from the provider's own usage report rather than estimated, and
   * persisted so a reloaded session still knows how close it is to the
   * compaction threshold.
   */
  lastPromptTokens: number;
  history: LlmMessage[];
};

export type SessionStore = {
  /** Reads a record, or `null` when it is absent, corrupt, or unreadable. */
  load(id: string): Promise<PersistedSession | null>;
  /** Writes a record atomically. */
  save(record: PersistedSession): Promise<void>;
  /** Deletes a record, reporting whether one existed. */
  remove(id: string): Promise<boolean>;
  /**
   * Lists stored sessions, newest first, optionally narrowed to a workspace.
   *
   * The store is the source of truth: a session is written on creation and
   * after every turn, so what is on disk is what has ever existed.
   */
  list(options?: ListSessionsOptions): Promise<ListSessionsResult>;
};

export type ListSessionsOptions = {
  /** Only sessions whose workspace is this path, or one of its roots. */
  cwd?: string;
  /** Opaque token returned by a previous page. */
  cursor?: string;
  /** Page size. Defaults to `LIST_PAGE_SIZE`. */
  limit?: number;
};

export type StoredSession = PersistedSession & {
  /** ISO timestamp of the last write, which is what orders the listing. */
  updatedAt: string;
};

export type ListSessionsResult = {
  sessions: StoredSession[];
  /** Present only when further pages remain. */
  nextCursor?: string;
};

/** Sessions returned by one `session/list` page. */
export const LIST_PAGE_SIZE = 50;

/**
 * Session ids that become filenames, so a hostile client cannot traverse out
 * of the store directory through `session/load`'s client-supplied `sessionId`.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function isSafeId(id: unknown): id is string {
  return typeof id === "string" && ID_PATTERN.test(id);
}

/**
 * Builds a store backed by one JSON file per session under `dir`.
 *
 * Without a directory the store never touches disk, which is what the tests
 * want: they exercise the protocol without writing to the real home directory.
 *
 * Persistence is what makes `session/load` worth implementing. The client
 * restarts the agent process between editor sessions, so an in-memory
 * transcript cannot survive long enough for a reloaded thread to be useful.
 */
export function createSessionStore(dir?: string): SessionStore {
  if (!dir) {
    return {
      load: async () => null,
      save: async () => {},
      remove: async () => false,
      list: async () => ({ sessions: [] }),
    };
  }

  const fileFor = (id: string) => join(dir, `${id}.json`);

  return {
    async load(id) {
      if (!isSafeId(id)) return null;
      try {
        return parseRecord(await readFile(fileFor(id), "utf8"));
      } catch {
        // Absent, unreadable, and malformed all mean "no such session".
        return null;
      }
    },

    async save(record) {
      if (!isSafeId(record.id)) return;

      await mkdir(dir, { recursive: true });

      // Write-then-rename, so a kill mid-save leaves the previous record
      // readable instead of leaving a truncated file behind.
      const target = fileFor(record.id);
      const temp = `${target}.tmp`;
      await writeFile(
        temp,
        JSON.stringify({ version: SESSION_RECORD_VERSION, ...record }),
        "utf8",
      );
      await rename(temp, target);

      await prune(dir);
    },

    async remove(id) {
      if (!isSafeId(id)) return false;
      try {
        await unlink(fileFor(id));
        return true;
      } catch {
        return false;
      }
    },

    async list(options = {}) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return { sessions: [] };
      }

      const stored: StoredSession[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const path = join(dir, name);
        try {
          const [raw, stats] = await Promise.all([readFile(path, "utf8"), stat(path)]);
          const record = parseRecord(raw);
          if (!record) continue;
          if (options.cwd && !belongsTo(record, options.cwd)) continue;
          stored.push({ ...record, updatedAt: new Date(stats.mtimeMs).toISOString() });
        } catch {
          // Removed or unreadable between `readdir` and the read: not listable.
        }
      }

      // Newest first, so the page a client asks for is the one it wants.
      stored.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

      const offset = decodeCursor(options.cursor);
      const limit = options.limit && options.limit > 0 ? options.limit : LIST_PAGE_SIZE;
      const page = stored.slice(offset, offset + limit);
      const after = offset + page.length;

      return {
        sessions: page,
        ...(after < stored.length ? { nextCursor: String(after) } : {}),
      };
    },
  };
}

/** Whether a session belongs to the workspace the client asked about. */
function belongsTo(record: PersistedSession, cwd: string): boolean {
  return record.cwd === cwd || record.roots.includes(cwd);
}

/** Cursors are plain offsets; anything unparseable starts at the first page. */
function decodeCursor(cursor?: string | null): number {
  const offset = Number.parseInt(cursor ?? "", 10);
  return Number.isFinite(offset) && offset > 0 ? offset : 0;
}

/** Drops the oldest records once the directory holds more than the cap. */
async function prune(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }

  const records = names.filter((name) => name.endsWith(".json"));
  if (records.length <= MAX_PERSISTED_SESSIONS) return;

  const oldestFirst: Array<{ name: string; mtime: number }> = [];
  for (const name of records) {
    try {
      oldestFirst.push({ name, mtime: (await stat(join(dir, name))).mtimeMs });
    } catch {
      // Removed under us; there is nothing left to drop.
    }
  }
  oldestFirst.sort((left, right) => left.mtime - right.mtime);

  const excess = oldestFirst.slice(0, records.length - MAX_PERSISTED_SESSIONS);
  await Promise.all(
    excess.map(async ({ name }) => {
      try {
        await unlink(join(dir, name));
      } catch {
        // Another writer may have removed it first.
      }
    }),
  );
}

/* ------------------------------------------------------------------ *
 * Parsing
 *
 * Records are read back from disk, so every field is checked rather than
 * cast: a corrupt file must degrade to a missing session, never to a
 * malformed transcript reaching the model.
 * ------------------------------------------------------------------ */

function parseRecord(raw: string): PersistedSession | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (record.version !== SESSION_RECORD_VERSION) return null;
  if (!isSafeId(record.id)) return null;
  if (typeof record.cwd !== "string" || record.cwd.length === 0) return null;
  if (typeof record.model !== "string" || record.model.length === 0) return null;

  const roots = parseStringArray(record.roots);
  if (!roots || roots.length === 0) return null;

  const history = parseHistory(record.history);
  if (!history) return null;

  return {
    id: record.id,
    cwd: record.cwd,
    roots,
    model: record.model,
    allowedTools: parseStringArray(record.allowedTools) ?? [],
    messageCounter:
      typeof record.messageCounter === "number" && Number.isFinite(record.messageCounter)
        ? Math.max(0, Math.trunc(record.messageCounter))
        : 0,
    // Optional, so records written before it existed still load.
    lastPromptTokens:
      typeof record.lastPromptTokens === "number" && Number.isFinite(record.lastPromptTokens)
        ? Math.max(0, Math.trunc(record.lastPromptTokens))
        : 0,
    history,
  };
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    items.push(entry);
  }
  return items;
}

const LLM_ROLES = new Set(["system", "user", "assistant", "tool"]);

function parseHistory(value: unknown): LlmMessage[] | null {
  if (!Array.isArray(value)) return null;

  const messages: LlmMessage[] = [];
  for (const entry of value) {
    const message = parseMessage(entry);
    if (!message) return null;
    messages.push(message);
  }
  return messages;
}

function parseMessage(value: unknown): LlmMessage | null {
  if (typeof value !== "object" || value === null) return null;

  const raw = value as Record<string, unknown>;
  if (typeof raw.role !== "string" || !LLM_ROLES.has(raw.role)) return null;
  if (raw.content !== null && typeof raw.content !== "string") return null;

  const message: LlmMessage = {
    role: raw.role as LlmRole,
    content: raw.content as string | null,
  };

  if (raw.tool_calls !== undefined) {
    if (!Array.isArray(raw.tool_calls)) return null;
    const calls: LlmToolCall[] = [];
    for (const entry of raw.tool_calls) {
      const call = parseToolCall(entry);
      if (!call) return null;
      calls.push(call);
    }
    if (calls.length > 0) message.tool_calls = calls;
  }

  if (raw.tool_call_id !== undefined) {
    if (typeof raw.tool_call_id !== "string") return null;
    message.tool_call_id = raw.tool_call_id;
  }

  return message;
}

function parseToolCall(value: unknown): LlmToolCall | null {
  if (typeof value !== "object" || value === null) return null;

  const raw = value as Record<string, unknown>;
  const fn = raw.function as Record<string, unknown> | null | undefined;
  if (typeof raw.id !== "string" || typeof fn?.name !== "string" || typeof fn.arguments !== "string") {
    return null;
  }

  return { id: raw.id, type: "function", function: { name: fn.name, arguments: fn.arguments } };
}
