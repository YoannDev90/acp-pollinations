import { spawn } from "node:child_process";
import { glob, open, readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import type { AgentContext, ClientCapabilities, ToolKind } from "@agentclientprotocol/sdk";
import { methods } from "@agentclientprotocol/sdk";

import type { LlmToolDefinition } from "./llm.js";

export type ToolName =
  | "read_file"
  | "write_file"
  | "edit_file"
  | "list_dir"
  | "glob"
  | "grep"
  | "bash";

export type ToolLocation = { path: string; line?: number };

export type ToolExecutionResult = {
  /** Text handed back to the model as the tool result. */
  output: string;
  isError?: boolean;
  /** File locations the client can open ("follow the agent"). */
  locations?: ToolLocation[];
  /** Diff to render for write operations. */
  diff?: { path: string; oldText?: string | null; newText: string };
  /** Client terminal still rendering live output, when one was used. */
  terminalId?: string;
};

export type ToolContext = {
  sessionId: string;
  /** Session working directory; also the default root for relative paths. */
  cwd: string;
  /** Absolute paths the session may touch: `cwd` plus additional directories. */
  roots: string[];
  client: AgentContext;
  clientCapabilities: ClientCapabilities | null;
  signal: AbortSignal;
  /**
   * Resolves whether a mutating tool may run. Returning `false` aborts the
   * tool call without failing the turn.
   */
  approve: (params: {
    name: ToolName;
    kind: ToolKind;
    title: string;
    rawInput: unknown;
  }) => Promise<boolean>;
};

/** A tool as stored in this module: the OpenAI schema plus agent metadata. */
export type ToolDefinition = Omit<LlmToolDefinition, "type"> & {
  kind: ToolKind;
  /** Mutating tools ask the client for permission first. */
  mutating: boolean;
  /** Human-readable one-liner used as the ACP `tool_call` title. */
  title: (input: Record<string, unknown>) => string;
};

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

const MAX_OUTPUT_CHARS = 20_000;
const MAX_MATCHES = 50;
const MAX_GLOB_RESULTS = 200;
const MAX_FILE_BYTES = 1_000_000;
const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".cache",
  "coverage",
]);

/** Tool schemas and metadata advertised to the model. */
export const TOOL_DEFINITIONS: Record<ToolName, ToolDefinition> = {
  read_file: {
    kind: "read",
    mutating: false,
    title: (input) => `Read ${shortPath(input.path)}`,
    function: {
      name: "read_file",
      description:
        "Read a text file from the workspace. Use `line`/`limit` for large files; line numbers are 1-based.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or cwd-relative file path" },
          line: { type: "integer", description: "1-based line to start from" },
          limit: { type: "integer", description: "Maximum number of lines to return" },
        },
        required: ["path"],
      },
    },
  },
  write_file: {
    kind: "edit",
    mutating: true,
    title: (input) => `Write ${shortPath(input.path)}`,
    function: {
      name: "write_file",
      description:
        "Create or overwrite a text file with the given content. Creates parent directories as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or cwd-relative file path" },
          content: { type: "string", description: "Full new content of the file" },
        },
        required: ["path", "content"],
      },
    },
  },
  edit_file: {
    kind: "edit",
    mutating: true,
    title: (input) => `Edit ${shortPath(input.path)}`,
    function: {
      name: "edit_file",
      description:
        "Replace an exact text snippet in a file. `old_text` must appear exactly once unless `replace_all` is true. Prefer this over write_file for small changes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or cwd-relative file path" },
          old_text: { type: "string", description: "Exact text to replace" },
          new_text: { type: "string", description: "Replacement text" },
          replace_all: { type: "boolean", description: "Replace every occurrence" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  list_dir: {
    kind: "read",
    mutating: false,
    title: (input) => `List ${shortPath(input.path ?? ".")}`,
    function: {
      name: "list_dir",
      description: "List the entries of a directory, one per line, with / for directories.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path; defaults to the workspace root" },
        },
      },
    },
  },
  glob: {
    kind: "search",
    mutating: false,
    title: (input) => `Find ${String(input.pattern ?? "*")}`,
    function: {
      name: "glob",
      description:
        "Find files matching a glob pattern such as `**/*.ts` or `src/**/*.js`. Returns matching paths, one per line.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern" },
          path: { type: "string", description: "Directory to search; defaults to the workspace root" },
        },
        required: ["pattern"],
      },
    },
  },
  grep: {
    kind: "search",
    mutating: false,
    title: (input) => `Search for ${String(input.pattern ?? "")}`,
    function: {
      name: "grep",
      description:
        "Search file contents with a regular expression. Returns `path:line: text` matches, one per line.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression to search for" },
          path: { type: "string", description: "Directory to search; defaults to the workspace root" },
          include: { type: "string", description: "Only search files whose name matches this glob" },
          limit: { type: "integer", description: `Maximum matches to return (default ${MAX_MATCHES})` },
        },
        required: ["pattern"],
      },
    },
  },
  bash: {
    kind: "execute",
    mutating: true,
    title: (input) => `Run ${truncate(String(input.command ?? ""), 80)}`,
    function: {
      name: "bash",
      description:
        "Run a shell command in the workspace and return its output and exit code. Use it to build, test, and inspect the project.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run" },
        },
        required: ["command"],
      },
    },
  },
};

/** The OpenAI tool definitions sent to the model. */
export const LLM_TOOLS: LlmToolDefinition[] = Object.values(TOOL_DEFINITIONS).map(
  ({ function: fn }) => ({ type: "function", function: fn }),
);

/**
 * Runs one tool call on behalf of the model.
 *
 * Never throws: failures come back as `isError` results so the model can
 * recover instead of losing the turn.
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const definition = TOOL_DEFINITIONS[name as ToolName];
  if (!definition) return { output: `Unknown tool: ${name}`, isError: true };

  if (definition.mutating) {
    const approved = await ctx.approve({
      name: name as ToolName,
      kind: definition.kind,
      title: definition.title(input),
      rawInput: input,
    });
    if (!approved) return { output: "The user rejected this operation.", isError: true };
  }

  try {
    switch (name as ToolName) {
      case "read_file":
        return await readFileTool(input, ctx);
      case "write_file":
        return await writeFileTool(input, ctx);
      case "edit_file":
        return await editFileTool(input, ctx);
      case "list_dir":
        return await listDirTool(input, ctx);
      case "glob":
        return await globTool(input, ctx);
      case "grep":
        return await grepTool(input, ctx);
      case "bash":
        return await bashTool(input, ctx);
      default:
        return { output: `Unknown tool: ${name}`, isError: true };
    }
  } catch (error) {
    return { output: error instanceof Error ? error.message : String(error), isError: true };
  }
}

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

/** Resolves a path and enforces the session's workspace root set. */
function resolveInRoots(path: unknown, ctx: ToolContext): string {
  if (typeof path !== "string" || path.trim() === "") {
    throw new ToolError("A non-empty `path` is required");
  }

  const absolute = resolve(ctx.cwd, path);
  const allowed = ctx.roots.some((root) => {
    const base = resolve(root);
    return absolute === base || absolute.startsWith(base.endsWith(sep) ? base : base + sep);
  });

  if (!allowed) {
    throw new ToolError(
      `Refusing to access ${absolute}: it is outside the session workspace (${ctx.roots.join(", ")})`,
    );
  }
  return absolute;
}

function shortPath(path: unknown): string {
  return typeof path === "string" && path ? truncate(path, 60) : "<path>";
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function clip(value: string): string {
  return value.length <= MAX_OUTPUT_CHARS
    ? value
    : `${value.slice(0, MAX_OUTPUT_CHARS)}\n… output truncated (${value.length} characters total)`;
}

/* ------------------------------------------------------------------ *
 * File tools
 * ------------------------------------------------------------------ */

async function readFileTool(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const path = resolveInRoots(input.path, ctx);
  const line = typeof input.line === "number" ? input.line : undefined;
  const limit = typeof input.limit === "number" ? input.limit : undefined;

  // Prefer the client's filesystem so unsaved editor buffers are visible.
  let content: string;
  if (ctx.clientCapabilities?.fs?.readTextFile) {
    const response = await ctx.client.request(methods.client.fs.readTextFile, {
      sessionId: ctx.sessionId,
      path,
      ...(line !== undefined ? { line } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    content = response.content;
  } else {
    content = await readLocalFile(path);
    content = applyLineWindow(content, line, limit);
  }

  return {
    output: clip(content),
    locations: [{ path, ...(line !== undefined ? { line } : {}) }],
  };
}

async function readLocalFile(path: string): Promise<string> {
  try {
    const stats = await stat(path);
    if (stats.size > MAX_FILE_BYTES) {
      throw new ToolError(`${path} is too large to read (${stats.size} bytes)`);
    }
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof ToolError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new ToolError(`File not found: ${path}`);
    if (code === "EISDIR") throw new ToolError(`${path} is a directory, use list_dir instead`);
    throw error;
  }
}

function applyLineWindow(content: string, line?: number, limit?: number): string {
  if (line === undefined && limit === undefined) return content;
  const lines = content.split("\n");
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit === undefined ? lines.length : start + limit;
  return lines.slice(start, end).join("\n");
}

async function writeFileTool(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const path = resolveInRoots(input.path, ctx);
  const content = typeof input.content === "string" ? input.content : null;
  if (content === null) throw new ToolError("A string `content` is required");

  const oldText = await readIfExists(path);

  if (ctx.clientCapabilities?.fs?.writeTextFile) {
    await ctx.client.request(methods.client.fs.writeTextFile, {
      sessionId: ctx.sessionId,
      path,
      content,
    });
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }

  return {
    output: oldText === null ? `Created ${path} (${content.length} bytes)` : `Updated ${path} (${content.length} bytes)`,
    locations: [{ path }],
    diff: { path, oldText, newText: content },
  };
}

async function editFileTool(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const path = resolveInRoots(input.path, ctx);
  const oldText = typeof input.old_text === "string" ? input.old_text : null;
  const newText = typeof input.new_text === "string" ? input.new_text : null;
  const replaceAll = input.replace_all === true;

  if (oldText === null || newText === null) {
    throw new ToolError("`old_text` and `new_text` must both be strings");
  }
  if (oldText === "") throw new ToolError("`old_text` must not be empty");

  const current = await readLocalFile(path);
  const occurrences = current.split(oldText).length - 1;
  if (occurrences === 0) throw new ToolError(`\`${truncate(oldText, 80)}\` was not found in ${path}`);
  if (occurrences > 1 && !replaceAll) {
    throw new ToolError(
      `\`${truncate(oldText, 80)}\` appears ${occurrences} times in ${path}; add more surrounding context or set replace_all`,
    );
  }

  const updated = replaceAll ? current.split(oldText).join(newText) : current.replace(oldText, newText);

  if (ctx.clientCapabilities?.fs?.writeTextFile) {
    await ctx.client.request(methods.client.fs.writeTextFile, {
      sessionId: ctx.sessionId,
      path,
      content: updated,
    });
  } else {
    await writeFile(path, updated, "utf8");
  }

  return {
    output: `Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${path}`,
    locations: [{ path }],
    diff: { path, oldText: current, newText: updated },
  };
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Search tools
 * ------------------------------------------------------------------ */

async function listDirTool(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const path = input.path === undefined ? resolve(ctx.cwd) : resolveInRoots(input.path, ctx);

  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new ToolError(`Directory not found: ${path}`);
    if (code === "ENOTDIR") throw new ToolError(`${path} is not a directory`);
    throw error;
  }

  const lines = entries
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));

  return {
    output: lines.length ? clip(lines.join("\n")) : "(empty directory)",
    locations: [{ path }],
  };
}

async function globTool(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const pattern = typeof input.pattern === "string" ? input.pattern.trim() : "";
  if (!pattern) throw new ToolError("A non-empty `pattern` is required");

  const root = input.path === undefined ? resolve(ctx.cwd) : resolveInRoots(input.path, ctx);
  const matches: string[] = [];

  // `fs.promises.glob` walks the tree for us; `exclude` keeps vendored and
  // build directories out of the results.
  for await (const candidate of glob(pattern, { cwd: root, exclude: shouldSkipPath })) {
    if (matches.length >= MAX_GLOB_RESULTS) break;
    matches.push(resolve(root, candidate));
  }

  return {
    output: matches.length
      ? clip(matches.join("\n"))
      : `No files matched \`${pattern}\``,
    locations: matches.slice(0, 20).map((path) => ({ path })),
  };
}

async function grepTool(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  if (!pattern) throw new ToolError("A non-empty `pattern` is required");

  let expression: RegExp;
  try {
    expression = new RegExp(pattern, "g");
  } catch (error) {
    throw new ToolError(`Invalid regular expression: ${(error as Error).message}`);
  }

  const root = input.path === undefined ? resolve(ctx.cwd) : resolveInRoots(input.path, ctx);
  const include = typeof input.include === "string" && input.include ? globToRegExp(input.include) : null;
  const limit = typeof input.limit === "number" && input.limit > 0 ? Math.min(input.limit, 200) : MAX_MATCHES;

  const matches: string[] = [];
  const locations: ToolLocation[] = [];
  let truncated = false;

  outer: for await (const candidate of glob("**/*", { cwd: root, exclude: shouldSkipPath })) {
    const path = resolve(root, candidate);
    if (include && !include.test(candidate)) continue;

    const content = await readTextIfSafe(path);
    if (content === null) continue;

    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      expression.lastIndex = 0;
      if (!expression.test(line)) continue;

      matches.push(`${path}:${index + 1}: ${truncate(line.trim(), 200)}`);
      // One location per matching line, so the client can jump to each hit.
      if (locations.length < 20) locations.push({ path, line: index + 1 });
      if (matches.length >= limit) {
        truncated = true;
        break outer;
      }
    }
  }

  return {
    output: matches.length
      ? clip(matches.join("\n")) + (truncated ? "\n… match limit reached" : "")
      : `No matches for \`${pattern}\``,
    ...(locations.length ? { locations } : {}),
  };
}

async function readTextIfSafe(path: string): Promise<string | null> {
  try {
    const stats = await stat(path);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return null;

    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(1024, stats.size));
      await handle.read(buffer, 0, buffer.length, 0);
      if (buffer.includes(0)) return null; // binary
    } finally {
      await handle.close();
    }

    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * `fs.promises.glob` exclude callback: keeps vendored, build, and VCS
 * directories out of both `glob` and `grep` results.
 */
function shouldSkipPath(fileName: string): boolean {
  return fileName.split(/[\\/]/).some((segment) => SKIP_DIRECTORIES.has(segment));
}

/** Translates a glob pattern into an anchored regular expression. */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index] as string;

    if (char === "*") {
      if (pattern[index + 1] === "*") {
        // `**/` matches zero or more directories; bare `**` matches anything.
        if (pattern[index + 2] === "/") {
          source += "(?:[^/]+/)*";
          index += 3;
        } else {
          source += ".*";
          index += 2;
        }
        continue;
      }
      source += "[^/]*";
      index += 1;
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }

    if (char === "{") {
      const end = pattern.indexOf("}", index);
      if (end !== -1) {
        const alternatives = pattern.slice(index + 1, end).split(",");
        source += `(?:${alternatives.map((alt) => alt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
        index = end + 1;
        continue;
      }
    }

    source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }

  return new RegExp(`^${source}$`);
}

/* ------------------------------------------------------------------ *
 * Shell
 * ------------------------------------------------------------------ */

const BASH_TIMEOUT_MS = 120_000;

async function bashTool(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) throw new ToolError("A non-empty `command` is required");

  const run = ctx.clientCapabilities?.terminal
    ? runViaClientTerminal
    : runLocally;

  const result = await run(command, ctx);

  const status = result.exitCode === 0 ? "succeeded" : `failed with exit code ${result.exitCode}`;
  return {
    output: clip(
      `$ ${command}\n${result.output}\n[command ${status}]`.trim(),
    ),
    isError: result.exitCode !== 0,
    ...(result.terminalId ? { terminalId: result.terminalId } : {}),
  };
}

type CommandResult = { output: string; exitCode: number | null; terminalId?: string };

/** Executes through the client's `terminal/*` methods, when advertised. */
async function runViaClientTerminal(command: string, ctx: ToolContext): Promise<CommandResult> {
  const handle = await ctx.client.createTerminal({
    sessionId: ctx.sessionId,
    command: "/bin/sh",
    args: ["-c", command],
    cwd: ctx.cwd,
  });

  try {
    const killTimer = setTimeout(() => {
      void handle.kill().catch(() => undefined);
    }, BASH_TIMEOUT_MS);

    try {
      const exit = await handle.waitForExit();
      const output = await handle.currentOutput();
      return { output: output.output, exitCode: exit.exitCode ?? null, terminalId: handle.id };
    } finally {
      clearTimeout(killTimer);
    }
  } finally {
    await handle.release().catch(() => undefined);
  }
}

/** Fallback for clients without the `terminal` capability. */
function runLocally(command: string, ctx: ToolContext): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: ctx.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > MAX_OUTPUT_CHARS * 2) output = output.slice(-MAX_OUTPUT_CHARS);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const timer = setTimeout(() => child.kill("SIGKILL"), BASH_TIMEOUT_MS);
    const onAbort = () => child.kill("SIGKILL");
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    child.on("close", (code) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      resolvePromise({ output, exitCode: code });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      resolvePromise({ output: `${output}${error.message}`, exitCode: null });
    });
  });
}
