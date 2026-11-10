import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { AgentContext } from "@agentclientprotocol/sdk";

import { LLM_TOOLS, TOOL_DEFINITIONS, executeTool, globToRegExp } from "../src/tools/index.js";
import type { ToolContext, ToolExecutionResult } from "../src/tools/index.js";
import type { McpToolBinding } from "../src/mcp/index.js";
import { createTmpDir } from "./helpers/tmp.js";

/** Workspaces are created per test and removed once the file finishes. */
const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup()));
});

type Workspace = { path: string; context: ToolContext };

async function makeWorkspace(
  overrides: Partial<ToolContext> = {},
): Promise<Workspace> {
  const tmp = await createTmpDir("acp-tools");
  cleanups.push(tmp.cleanup);

  return {
    path: tmp.path,
    context: {
      sessionId: "sess_test",
      cwd: tmp.path,
      roots: [tmp.path],
      clientCapabilities: null,
      client: {} as AgentContext,
      signal: new AbortController().signal,
      approve: async () => true,
      ...overrides,
    },
  };
}

/** Asserts a tool failed and explains itself in the model-facing output. */
async function expectFailure(
  promise: Promise<ToolExecutionResult>,
  pattern: RegExp,
): Promise<void> {
  const result = await promise;
  expect(result.isError).toBe(true);
  expect(result.output).toMatch(pattern);
}

function expectSuccess(result: ToolExecutionResult): void {
  expect(result.isError).toBeFalsy();
}

describe("executeTool", () => {
  it("reports unknown tool names instead of throwing", async () => {
    const { context } = await makeWorkspace();
    await expectFailure(executeTool("nope", {}, context), /Unknown tool/);
  });

  it("treats a name that only exists on Object.prototype as unknown", async () => {
    const { context } = await makeWorkspace();
    // `TOOL_DEFINITIONS["constructor"]` resolves through the prototype chain
    // to a truthy value, so the lookup cannot be the only check: the switch
    // is what sends it back as unknown instead of running it as a tool.
    await expectFailure(executeTool("constructor", {}, context), /Unknown tool/);
  });

  describe("read_file", () => {
    it("returns the whole file with no line gutter", async () => {
      const { path, context } = await makeWorkspace();
      await writeFile(join(path, "a.txt"), "one\ntwo\nthree\n");

      const result = await executeTool("read_file", { path: join(path, "a.txt") }, context);

      expectSuccess(result);
      expect(result.output).toContain("one\ntwo\nthree");
      expect(result.output).not.toMatch(/^\s*\d+\s+\|/m);
      expect(result.locations).toEqual([{ path: join(path, "a.txt") }]);
    });

    it("applies a 1-based line window", async () => {
      const { path, context } = await makeWorkspace();
      await writeFile(join(path, "a.txt"), "l1\nl2\nl3\nl4\nl5\n");

      const result = await executeTool(
        "read_file",
        { path: join(path, "a.txt"), line: 2, limit: 2 },
        context,
      );

      expectSuccess(result);
      expect(result.output).toBe("l2\nl3");
      expect(result.locations?.[0]?.line).toBe(2);
    });

    it("asks the client's filesystem so unsaved buffers are visible", async () => {
      const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
      // The mock mirrors a real editor: `fs/read_text_file` returns the
      // buffer's content so the agent sees unsaved changes.
      const client = {
        request: async (method: string, params: Record<string, unknown>) => {
          seen.push({ method, params });
          return { content: "unsaved buffer" };
        },
      } as unknown as AgentContext;

      const { path, context } = await makeWorkspace({
        client,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
      });

      const result = await executeTool("read_file", { path: join(path, "a.txt") }, context);

      expectSuccess(result);
      expect(result.output).toBe("unsaved buffer");
      expect(seen[0]?.method).toContain("read_text_file");
      expect(seen[0]?.params).toMatchObject({ sessionId: "sess_test", path: join(path, "a.txt") });
    });

    it("refuses to read outside the workspace", async () => {
      const { context } = await makeWorkspace();
      await expectFailure(executeTool("read_file", { path: "/etc/passwd" }, context), /outside/);
    });

    it("explains a missing file", async () => {
      const { path, context } = await makeWorkspace();
      await expectFailure(
        executeTool("read_file", { path: join(path, "missing.txt") }, context),
        /File not found/,
      );
    });

    it("refuses directories", async () => {
      const { path, context } = await makeWorkspace();
      await expectFailure(executeTool("read_file", { path }, context), /is a directory/);
    });

    it("refuses files past the size ceiling", async () => {
      const { path, context } = await makeWorkspace();
      const big = join(path, "big.bin");
      await writeFile(big, Buffer.alloc(1_000_001));

      // The ceiling is checked before the read, and the size in the message
      // comes from the stat that triggered it.
      await expectFailure(executeTool("read_file", { path: big }, context), /too large to read \(1000001 bytes\)/);
    });

    it.skipIf(process.getuid?.() === 0)("surfaces errors that are neither missing files nor directories", async () => {
      const { path, context } = await makeWorkspace();
      const file = join(path, "locked.txt");
      await writeFile(file, "x\n");
      await chmod(file, 0o000);

      // A read that fails for a reason the tool does not translate keeps the
      // original error instead of being reported as missing.
      await expectFailure(executeTool("read_file", { path: file }, context), /EACCES/);
    });
  });

  describe("write_file", () => {
    it("creates intermediate directories and returns a diff", async () => {
      const { path, context } = await makeWorkspace();
      const target = join(path, "deep", "nested", "b.txt");

      const result = await executeTool("write_file", { path: target, content: "hi" }, context);

      expectSuccess(result);
      expect(await readFile(target, "utf8")).toBe("hi");
      expect(result.diff?.newText).toBe("hi");
      expect(result.output).toMatch(/^Created .*\(2 bytes\)$/);
    });

    it("writes through the client when it offers a filesystem", async () => {
      const seen: string[] = [];
      // `write_file` writes straight through the client without a prior read.
      const client = {
        request: async (method: string) => {
          seen.push(method);
          return {};
        },
      } as unknown as AgentContext;

      const { path, context } = await makeWorkspace({
        client,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });

      const result = await executeTool(
        "write_file",
        { path: join(path, "via-client.txt"), content: "x" },
        context,
      );

      expectSuccess(result);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("write_text_file");
    });

    it("requires a string content", async () => {
      const { path, context } = await makeWorkspace();
      await expectFailure(
        executeTool("write_file", { path: join(path, "c.txt") }, context),
        /`content` is required/,
      );
    });
  });

  describe("edit_file", () => {
    it("replaces text and reports old and new content", async () => {
      const { path, context } = await makeWorkspace();
      const file = join(path, "c.txt");
      await writeFile(file, "alpha beta\n");

      const result = await executeTool(
        "edit_file",
        { path: file, old_text: "alpha", new_text: "omega" },
        context,
      );

      expectSuccess(result);
      expect(await readFile(file, "utf8")).toBe("omega beta\n");
      expect(result.diff).toEqual({ path: file, oldText: "alpha beta\n", newText: "omega beta\n" });
    });

    it("errors when old_text matches more than once", async () => {
      const { path, context } = await makeWorkspace();
      const file = join(path, "d.txt");
      await writeFile(file, "x x x\n");

      await expectFailure(
        executeTool("edit_file", { path: file, old_text: "x", new_text: "y" }, context),
        /appears 3 times/,
      );
    });

    it("errors when old_text is absent", async () => {
      const { path, context } = await makeWorkspace();
      const file = join(path, "e.txt");
      await writeFile(file, "hello\n");

      await expectFailure(
        executeTool("edit_file", { path: file, old_text: "bye", new_text: "hi" }, context),
        /was not found/,
      );
    });

    it("honours replace_all", async () => {
      const { path, context } = await makeWorkspace();
      const file = join(path, "f.txt");
      await writeFile(file, "x x\n");

      const result = await executeTool(
        "edit_file",
        { path: file, old_text: "x", new_text: "y", replace_all: true },
        context,
      );

      expectSuccess(result);
      expect(await readFile(file, "utf8")).toBe("y y\n");
    });

    it("refuses paths outside the workspace", async () => {
      const { context } = await makeWorkspace();
      await expectFailure(
        executeTool(
          "edit_file",
          { path: "/etc/hostname", old_text: "a", new_text: "b" },
          context,
        ),
        /outside/,
      );
    });

    it("requires both texts to be strings", async () => {
      const { path, context } = await makeWorkspace();
      await writeFile(join(path, "g.txt"), "x\n");

      // The model decides the arguments; a number in `old_text` is a usage
      // error to report, not a crash inside `String.split`.
      await expectFailure(
        executeTool(
          "edit_file",
          { path: join(path, "g.txt"), old_text: 42, new_text: "y" },
          context,
        ),
        /must both be strings/,
      );
    });

    it("refuses an empty old_text", async () => {
      const { path, context } = await makeWorkspace();
      await writeFile(join(path, "h.txt"), "x\n");

      await expectFailure(
        executeTool(
          "edit_file",
          { path: join(path, "h.txt"), old_text: "", new_text: "y" },
          context,
        ),
        /must not be empty/,
      );
    });

    it("edits through the client when it offers a filesystem", async () => {
      const seen: string[] = [];
      // The editor holds the authoritative buffer: unsaved changes must be
      // what the replacement is computed against, and the write goes back
      // through the client instead of onto disk.
      const client = {
        request: async (method: string) => {
          seen.push(method);
          return method.includes("read_text_file") ? { content: "alpha beta\n" } : {};
        },
      } as unknown as AgentContext;

      const { path, context } = await makeWorkspace({
        client,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });
      const file = join(path, "buffer.txt");

      const result = await executeTool(
        "edit_file",
        { path: file, old_text: "alpha", new_text: "omega" },
        context,
      );

      expectSuccess(result);
      expect(seen).toEqual([
        expect.stringContaining("read_text_file"),
        expect.stringContaining("write_text_file"),
      ]);
      expect(result.diff).toEqual({
        path: file,
        oldText: "alpha beta\n",
        newText: "omega beta\n",
      });
    });
  });

  describe("list_dir", () => {
    it("marks directories and sizes files", async () => {
      const { path, context } = await makeWorkspace();
      await mkdir(join(path, "sub"));
      await writeFile(join(path, "g.txt"), "abcd");

      const result = await executeTool("list_dir", { path }, context);

      expectSuccess(result);
      expect(result.output).toContain("sub/");
      expect(result.output).toContain("g.txt");
    });

    it("explains a missing directory", async () => {
      const { path, context } = await makeWorkspace();
      await expectFailure(
        executeTool("list_dir", { path: join(path, "nope") }, context),
        /Directory not found/,
      );
    });

    it("explains when the target is a file", async () => {
      const { path, context } = await makeWorkspace();
      const file = join(path, "not-a-dir.txt");
      await writeFile(file, "x\n");

      await expectFailure(executeTool("list_dir", { path: file }, context), /is not a directory/);
    });

    it.skipIf(process.getuid?.() === 0)("keeps the original error for anything else", async () => {
      const { path, context } = await makeWorkspace();
      const locked = join(path, "locked");
      await mkdir(locked);
      // Root ignores mode bits, so only a normal user can produce this.
      await chmod(locked, 0o000);

      await expectFailure(executeTool("list_dir", { path: locked }, context), /EACCES/);
    });
  });

  describe("glob", () => {
    it("matches with ** and skips vendored directories", async () => {
      const { path, context } = await makeWorkspace();
      await mkdir(join(path, "src"), { recursive: true });
      await mkdir(join(path, "node_modules", "pkg"), { recursive: true });
      await mkdir(join(path, "dist"), { recursive: true });
      await writeFile(join(path, "src", "h.ts"), "");
      await writeFile(join(path, "node_modules", "pkg", "i.ts"), "");
      await writeFile(join(path, "dist", "j.ts"), "");
      await writeFile(join(path, "k.md"), "");

      const result = await executeTool("glob", { pattern: "**/*.ts", path }, context);

      expectSuccess(result);
      expect(result.output).toContain(join(path, "src", "h.ts"));
      expect(result.output).not.toContain("node_modules");
      expect(result.output).not.toContain(join("dist", "j.ts"));
      expect(result.locations?.length).toBe(1);
    });

    it("reports no matches instead of failing", async () => {
      const { path, context } = await makeWorkspace();
      const result = await executeTool("glob", { pattern: "*.nope", path }, context);

      expectSuccess(result);
      expect(result.output).toMatch(/No files matched/);
    });

    it("requires a pattern", async () => {
      const { context } = await makeWorkspace();
      await expectFailure(executeTool("glob", {}, context), /`pattern` is required/);
    });
  });

  describe("grep", () => {
    it("returns path:line: matches and skips binaries", async () => {
      const { path, context } = await makeWorkspace();
      await writeFile(join(path, "search.txt"), "nothing\nneedle here\n");
      await writeFile(join(path, "skip.bin"), `needle${"\u0000"}`);

      const result = await executeTool("grep", { pattern: "needle", path }, context);

      expectSuccess(result);
      expect(result.output).toContain("needle here");
      expect(result.locations?.[0]?.line).toBe(2);
      expect(result.output).not.toContain("skip.bin");
    });

    it("filters by include pattern", async () => {
      const { path, context } = await makeWorkspace();
      await writeFile(join(path, "one.ts"), "needle\n");
      await writeFile(join(path, "two.txt"), "needle\n");

      const result = await executeTool(
        "grep",
        { pattern: "needle", path, include: "*.ts" },
        context,
      );

      expectSuccess(result);
      expect(result.output).toContain("one.ts");
      expect(result.output).not.toContain("two.txt");
    });

    it("treats the pattern as a regular expression", async () => {
      const { path, context } = await makeWorkspace();
      await writeFile(join(path, "r.txt"), "abc123\n");

      const result = await executeTool("grep", { pattern: "abc\\d+", path }, context);
      expect(result.output).toContain("abc123");

      await expectFailure(
        executeTool("grep", { pattern: "abc(", path }, context),
        /Invalid regular expression/,
      );
    });

    it("requires a pattern", async () => {
      const { context } = await makeWorkspace();
      await expectFailure(executeTool("grep", {}, context), /`pattern` is required/);
    });

    it("reports no matches without failing", async () => {
      const { path, context } = await makeWorkspace();
      const result = await executeTool("grep", { pattern: "zzz_absent", path }, context);

      expectSuccess(result);
      expect(result.output).toMatch(/No matches/);
    });
  });

  describe("bash", () => {
    it("runs locally when the client has no terminal capability", async () => {
      const { context } = await makeWorkspace();

      const result = await executeTool("bash", { command: "echo hello-from-bash" }, context);

      expectSuccess(result);
      expect(result.output).toContain("hello-from-bash");
      expect(result.locations).toBeUndefined();
      expect(result.terminalId).toBeUndefined();
    });

    it("runs in a client terminal when one is offered", async () => {
      const { context } = await makeWorkspace({
        clientCapabilities: { terminal: true },
        client: {
          createTerminal: async () => ({
            id: "term_1",
            currentOutput: async () => ({ output: "hi\n", truncated: false }),
            waitForExit: async () => ({ exitCode: 0, signal: null }),
            kill: async () => undefined,
            release: async () => undefined,
          }),
        } as unknown as AgentContext,
      });

      const result = await executeTool("bash", { command: "echo hi" }, context);

      expectSuccess(result);
      expect(result.terminalId).toBe("term_1");
      expect(result.output).toContain("hi");
    });

    it("truncates oversized output", async () => {
      const { context } = await makeWorkspace();

      const result = await executeTool("bash", { command: "seq 1 40000" }, context);

      expectSuccess(result);
      expect(result.output.length).toBeLessThan(25_000);
    });

    it("surfaces a non-zero exit status", async () => {
      const { context } = await makeWorkspace();
      await expectFailure(executeTool("bash", { command: "exit 3" }, context), /exit code 3/);
    });

    it("requires a command", async () => {
      const { context } = await makeWorkspace();
      await expectFailure(executeTool("bash", {}, context), /`command` is required/);
    });
  });

  describe("permission gate", () => {
    it("asks approval before a mutating tool runs", async () => {
      const asks: string[] = [];
      const { path, context } = await makeWorkspace({
        approve: async ({ name }) => {
          asks.push(name);
          return true;
        },
      });

      await executeTool("write_file", { path: join(path, "gated.txt"), content: "x" }, context);

      expect(asks).toEqual(["write_file"]);
    });

    it("skips approval for read-only tools", async () => {
      const { path, context } = await makeWorkspace({
        approve: async () => {
          throw new Error("should not be asked");
        },
      });
      await writeFile(join(path, "plain.txt"), "x\n");

      const result = await executeTool("read_file", { path: join(path, "plain.txt") }, context);

      expectSuccess(result);
    });

    it("reports a rejection without failing the tool call", async () => {
      const { path, context } = await makeWorkspace({ approve: async () => false });

      const result = await executeTool("write_file", { path: join(path, "no.txt"), content: "x" }, context);

      expect(result.isError).toBe(true);
      expect(result.output).toMatch(/rejected/);
    });
  });

  describe("plan mode", () => {
    it("refuses built-in mutating tools without asking for approval", async () => {
      const { path, context } = await makeWorkspace({
        mode: "plan",
        approve: async () => {
          throw new Error("should not be asked");
        },
      });

      const result = await executeTool(
        "write_file",
        { path: join(path, "plan.txt"), content: "x" },
        context,
      );

      expect(result.isError).toBe(true);
      expect(result.output).toMatch(/Plan mode/);
    });
  });

  describe("MCP tools", () => {
    /** A binding shaped like the ones `connectMcpServers` builds. */
    function binding(overrides: Partial<McpToolBinding> = {}): McpToolBinding {
      return {
        name: "remote_echo",
        kind: "read",
        mutating: false,
        title: (input) => `srv: remote_echo ${JSON.stringify(input)}`,
        call: async () => ({ output: "from remote", isError: false }),
        ...overrides,
      };
    }

    it("runs a read-only tool without asking for approval", async () => {
      const { context } = await makeWorkspace({
        approve: async () => {
          throw new Error("should not be asked");
        },
        mcpTools: new Map([["remote_echo", binding()]]),
      });

      const result = await executeTool("remote_echo", { text: "hi" }, context);

      expect(result).toEqual({ output: "from remote", isError: false });
    });

    it("asks approval before a mutating tool reaches the server", async () => {
      const asks: Array<{ name: string; title: string }> = [];
      const { context } = await makeWorkspace({
        approve: async ({ name, title }) => {
          asks.push({ name, title });
          return true;
        },
        mcpTools: new Map([
          [
            "remote_apply",
            binding({
              name: "remote_apply",
              mutating: true,
              title: (input) => `srv: remote_apply ${JSON.stringify(input)}`,
            }),
          ],
        ]),
      });

      const result = await executeTool("remote_apply", { text: "hi" }, context);

      // The gate sees the rendered title the client shows the user, not just
      // the raw tool name.
      expect(asks).toEqual([{ name: "remote_apply", title: 'srv: remote_apply {"text":"hi"}' }]);
      expect(result.output).toBe("from remote");
    });

    it("reports a rejection without calling the server", async () => {
      let calls = 0;
      const { context } = await makeWorkspace({
        approve: async () => false,
        mcpTools: new Map([
          [
            "remote_apply",
            binding({
              name: "remote_apply",
              mutating: true,
              call: async () => {
                calls += 1;
                return { output: "should not run", isError: false };
              },
            }),
          ],
        ]),
      });

      const result = await executeTool("remote_apply", {}, context);

      expect(result.isError).toBe(true);
      expect(result.output).toMatch(/rejected/);
      expect(calls).toBe(0);
    });

    it("refuses a mutating tool while the session is in plan mode", async () => {
      const { context } = await makeWorkspace({
        mode: "plan",
        approve: async () => {
          throw new Error("should not be asked");
        },
        mcpTools: new Map([["remote_apply", binding({ name: "remote_apply", mutating: true })]]),
      });

      const result = await executeTool("remote_apply", {}, context);

      expect(result.isError).toBe(true);
      expect(result.output).toMatch(/Plan mode/);
    });

    it("turns a server-side failure into an error result", async () => {
      const { context } = await makeWorkspace({
        mcpTools: new Map([
          [
            "remote_broken",
            binding({
              name: "remote_broken",
              call: async () => {
                throw new Error("server exploded");
              },
            }),
          ],
        ]),
      });

      const result = await executeTool("remote_broken", {}, context);

      // The turn survives: the model reads the failure as tool output.
      expect(result.isError).toBe(true);
      expect(result.output).toBe("server exploded");
    });
  });

  it("names read-only tools in the client's tool-call list", () => {
    // `executeTool` only renders titles for tools that ask permission, so the
    // read-only titles have to be exercised directly or they never show up.
    expect(TOOL_DEFINITIONS.list_dir.title({})).toBe("List .");
    expect(TOOL_DEFINITIONS.list_dir.title({ path: "/srv/project/src" })).toContain("/srv/project/src");
    expect(TOOL_DEFINITIONS.list_dir.title({ path: 42 })).toBe("List <path>");
    expect(TOOL_DEFINITIONS.grep.title({ pattern: "needle" })).toBe("Search for needle");
    expect(TOOL_DEFINITIONS.grep.title({ pattern: { nested: true } })).toBe("Search for ");
  });

  it("advertises every tool with a single-line description", () => {
    for (const definition of Object.values(TOOL_DEFINITIONS)) {
      expect(definition.function.description).not.toMatch(/\n/);
      expect(definition.function.parameters).toMatchObject({ type: "object" });
    }

    // The wire format adds the OpenAI `type: "function"` discriminator.
    expect(LLM_TOOLS.length).toBe(Object.keys(TOOL_DEFINITIONS).length);
    for (const tool of LLM_TOOLS) {
      expect(tool.type).toBe("function");
      expect(TOOL_DEFINITIONS).toHaveProperty(tool.function.name);
    }
  });
});

describe("globToRegExp", () => {
  it("anchors patterns and maps wildcards", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("src/a.ts")).toBe(false);
    expect(globToRegExp("**/*.ts").test("src/deep/a.ts")).toBe(true);
    expect(globToRegExp("a?.ts").test("a1.ts")).toBe(true);
    expect(globToRegExp("a?.ts").test("ab.ts")).toBe(true);
  });

  it("escapes regex metacharacters in literal segments", () => {
    expect(globToRegExp("a+b.txt").test("a+b.txt")).toBe(true);
    expect(globToRegExp("a+b.txt").test("aab.txt")).toBe(false);
  });

  it("treats a trailing ** as a match-anything suffix", () => {
    // Only `**/` gets the directory-aware form; a bare `**` matches any
    // characters, which is what `src/**` has to mean for nested paths.
    expect(globToRegExp("src/**").test("src/deep/a.ts")).toBe(true);
    expect(globToRegExp("src/**").test("other/deep/a.ts")).toBe(false);
  });

  it("expands brace alternatives into one anchored group", () => {
    const include = globToRegExp("*.{ts,js}");
    expect(include.test("a.ts")).toBe(true);
    expect(include.test("a.js")).toBe(true);
    expect(include.test("a.md")).toBe(false);
  });

  it("keeps a brace group it can close but cannot split", () => {
    // A single alternative is still a group; an unterminated brace is a
    // literal, so the pattern must stay usable either way.
    expect(globToRegExp("a{b}.txt").test("ab.txt")).toBe(true);
    expect(globToRegExp("a{b.txt").test("a{b.txt")).toBe(true);
  });
});
