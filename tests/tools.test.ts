import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { AgentContext } from "@agentclientprotocol/sdk";

import { LLM_TOOLS, TOOL_DEFINITIONS, executeTool, globToRegExp } from "../tools.js";
import type { ToolContext, ToolExecutionResult } from "../tools.js";
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
});
