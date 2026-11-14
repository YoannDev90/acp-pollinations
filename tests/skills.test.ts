import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  SKILL_FILE_NAME,
  defaultSkillRoots,
  discoverSkills,
  findSkill,
  isSkillCommandName,
  parseSkillMetadata,
  readSkillBody,
  renderSkillInvocation,
  renderSkillsIndex,
  skillCommandDescription,
  stripFrontmatter,
} from "../src/skills.js";
import type { Skill } from "../src/skills.js";
import { createTmpDir } from "./helpers/tmp.js";

const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup()));
});

/** Creates a root holding one `SKILL.md` per entry of `files`. */
async function makeRoot(files: Record<string, string>): Promise<string> {
  const root = await createTmpDir("acp-skill-root");
  cleanups.push(root.cleanup);

  for (const [name, content] of Object.entries(files)) {
    const directory = join(root.path, name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, SKILL_FILE_NAME), content, "utf8");
  }
  return root.path;
}

/** Creates an empty root, for fixtures that add their own entries. */
async function makeEmptyRoot(): Promise<string> {
  const root = await createTmpDir("acp-skill-root");
  cleanups.push(root.cleanup);
  return root.path;
}

describe("defaultSkillRoots", () => {
  it("looks in the workspace roots first, then the home directory", () => {
    const roots = defaultSkillRoots(["/workspace", "/other"], "/home/tester");

    expect(roots.slice(0, 4)).toEqual([
      "/workspace/.agents/skills",
      "/workspace/.claude/skills",
      "/other/.agents/skills",
      "/other/.claude/skills",
    ]);
    expect(roots).toContain("/home/tester/.agents/skills");
    expect(roots).toContain("/home/tester/.claude/skills");
  });

  it("never lists the same root twice", () => {
    const roots = defaultSkillRoots(["/workspace", "/workspace"], "/home/tester");

    expect(new Set(roots).size).toBe(roots.length);
  });

  it("reads the real home directory when none is given", () => {
    const roots = defaultSkillRoots(["/workspace"]);

    expect(roots.at(-1)).toContain(".claude");
    expect(roots.some((root) => root.startsWith("/workspace/"))).toBe(true);
  });
});

describe("discoverSkills", () => {
  it("reads every skill under the roots it is given", async () => {
    const root = await makeRoot({
      alpha: "---\nname: alpha\ndescription: First skill.\n---\nAlpha body.\n",
      beta: "---\ndescription: >\n  Second skill.\n---\nBeta body.\n",
    });

    const skills = await discoverSkills([root]);

    expect(skills.map((skill) => skill.name)).toEqual(["alpha", "beta"]);
    expect(skills[0]?.description).toBe("First skill.");
    expect(skills[0]?.path).toBe(join(root, "alpha", SKILL_FILE_NAME));
    // No `name` in the header: the directory name is the identity.
    expect(skills[1]?.description).toBe("Second skill.");
  });

  it("skips missing roots, plain files, dot directories, and directories without a header", async () => {
    const root = await makeRoot({
      alpha: "---\nname: alpha\ndescription: Keep.\n---\nBody.\n",
    });
    await mkdir(join(root, ".hidden"), { recursive: true });
    await writeFile(join(root, "plain.txt"), "not a skill", "utf8");
    await mkdir(join(root, "headerless"), { recursive: true });

    const skills = await discoverSkills([join(root, "missing"), root]);

    expect(skills.map((skill) => skill.name)).toEqual(["alpha"]);
  });

  it("keeps the first root's copy when two roots define the same skill", async () => {
    const project = await makeRoot({
      shared: "---\nname: shared\ndescription: Project copy.\n---\nProject body.\n",
    });
    const home = await makeRoot({
      shared: "---\nname: shared\ndescription: Home copy.\n---\nHome body.\n",
    });

    const skills = await discoverSkills([project, home]);

    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe("Project copy.");
  });

  it("follows a symlinked skill directory", async () => {
    const real = await makeRoot({
      linked: "---\nname: linked\ndescription: Linked skill.\n---\nBody.\n",
    });
    const root = await makeEmptyRoot();
    await symlink(join(real, "linked"), join(root, "linked"));

    const skills = await discoverSkills([root]);

    expect(skills.map((skill) => skill.name)).toContain("linked");
  });

  it("accepts a skill file with no frontmatter", async () => {
    const root = await makeRoot({ plain: "Just instructions, no header.\n" });

    const [skill] = await discoverSkills([root]);
    expect(skill?.name).toBe("plain");
    expect(skill?.description).toBe("");
    if (!skill) throw new Error("expected the plain skill to be discovered");
    expect(await readSkillBody(skill)).toBe("Just instructions, no header.");
  });

  it("stops at the ceiling instead of reading an unbounded root", async () => {
    const root = await makeEmptyRoot();
    for (let index = 0; index < 201; index += 1) {
      const directory = join(root, `skill-${String(index).padStart(3, "0")}`);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, SKILL_FILE_NAME), "---\ndescription: x\n---\n", "utf8");
    }

    const skills = await discoverSkills([root, root]);

    expect(skills).toHaveLength(200);
  });
});

describe("parseSkillMetadata", () => {
  it("reads plain and quoted scalars", () => {
    expect(parseSkillMetadata('---\nname: "quoted"\ndescription: it works\n---\n')).toEqual({
      name: "quoted",
      description: "it works",
    });
  });

  it("folds a folded block and keeps a literal block's line breaks", () => {
    expect(parseSkillMetadata("---\ndescription: >\n  one\n  two\n---\n").description).toBe(
      "one two",
    );
    expect(parseSkillMetadata("---\ndescription: |\n  one\n  two\n---\n").description).toBe(
      "one\ntwo",
    );
  });

  it("keeps a blank line inside a literal block as a paragraph break", () => {
    expect(parseSkillMetadata("---\ndescription: |\n  one\n\n  two\n---\n").description).toBe(
      "one\n\ntwo",
    );
    // A folded block drops the break but still has to skip past the gap.
    expect(parseSkillMetadata("---\ndescription: >\n  one\n\n  two\n---\n").description).toBe(
      "one two",
    );
  });

  it("continues a plain scalar on the next indented line", () => {
    expect(parseSkillMetadata("---\ndescription: first\n  continued\n---\n").description).toBe(
      "first continued",
    );
  });

  it("treats an empty value as an empty field rather than the block under it", () => {
    expect(parseSkillMetadata("---\ndescription:\n  nested: value\n---\n")).toEqual({
      description: "",
    });
    expect(parseSkillMetadata("---\ndescription:\n---\n")).toEqual({ description: "" });
  });

  it("ignores comments and lines that are not fields", () => {
    expect(parseSkillMetadata("---\n# a comment\ndescription: kept\n---\n")).toEqual({
      description: "kept",
    });
  });

  it("returns nothing for a file with no header or no closing delimiter", () => {
    expect(parseSkillMetadata("just a body\n")).toEqual({});
    expect(parseSkillMetadata("---\nname: never closed\n")).toEqual({});
  });
});

describe("stripFrontmatter", () => {
  it("drops the header and keeps the body", () => {
    expect(stripFrontmatter("---\nname: x\n---\nBody.\n")).toBe("Body.");
  });

  it("keeps a file without a header whole", () => {
    expect(stripFrontmatter("Body only.")).toBe("Body only.");
  });

  it("keeps an unclosed header as part of the body", () => {
    expect(stripFrontmatter("---\nname: x\n")).toBe("---\nname: x");
  });
});

describe("readSkillBody", () => {
  it("caps a body so one skill cannot fill the context window", async () => {
    const root = await makeRoot({ big: `---\nname: big\n---\n${"x".repeat(50_000)}` });
    const [skill] = await discoverSkills([root]);
    if (!skill) throw new Error("expected the big skill to be discovered");

    const body = await readSkillBody(skill);

    expect(body).toHaveLength(40_000 + "\n… (truncated)".length);
    expect(body.endsWith("… (truncated)")).toBe(true);
  });
});

describe("findSkill", () => {
  const skills: Skill[] = [{ name: "Caveman", description: "", path: "/x/SKILL.md" }];

  it("resolves a name case-insensitively and with a leading slash", () => {
    expect(findSkill(skills, "caveman")?.name).toBe("Caveman");
    expect(findSkill(skills, "/caveman")?.name).toBe("Caveman");
    expect(findSkill(skills, "  Caveman  ")?.name).toBe("Caveman");
  });

  it("finds nothing for an empty or unknown name", () => {
    expect(findSkill(skills, "   ")).toBeUndefined();
    expect(findSkill(skills, "missing")).toBeUndefined();
    expect(findSkill([], "caveman")).toBeUndefined();
  });
});

describe("isSkillCommandName", () => {
  it("accepts only names a client palette can echo back", () => {
    expect(isSkillCommandName("caveman")).toBe(true);
    expect(isSkillCommandName("skill-2")).toBe(true);
    expect(isSkillCommandName("Skill_2")).toBe(true);

    expect(isSkillCommandName("not a command")).toBe(false);
    expect(isSkillCommandName("/leading")).toBe(false);
    expect(isSkillCommandName("")).toBe(false);
  });
});

describe("skillCommandDescription", () => {
  it("collapses a description onto one line", () => {
    expect(
      skillCommandDescription({ name: "x", description: "  spaced\n out ", path: "/x" }),
    ).toBe("spaced out");
  });

  it("falls back to a usable description when the header has none", () => {
    expect(skillCommandDescription({ name: "x", description: "", path: "/x" })).toBe("Skill x");
  });
});

describe("renderSkillsIndex", () => {
  it("is empty when nothing is installed", () => {
    expect(renderSkillsIndex([])).toBe("");
  });

  it("names each skill and points at the tool that loads it", () => {
    const index = renderSkillsIndex([
      { name: "alpha", description: "Does things well.", path: "/a/SKILL.md" },
    ]);

    expect(index).toContain("`alpha`: Does things well.");
    expect(index).toContain("read_skill");
  });

  it("summarises a long description to its first sentence", () => {
    const description =
      "This first sentence is deliberately long enough to be worth summarising on its own. " +
      "And then a second sentence that carries on and on and should never reach the index.";
    const index = renderSkillsIndex([{ name: "alpha", description, path: "/a" }]);

    expect(index).toContain("worth summarising on its own.");
    expect(index).not.toContain("should never reach the index.");
  });

  it("hard-cuts a long description that has no sentence boundary", () => {
    const description = "no sentence here ".repeat(30);
    const line = renderSkillsIndex([{ name: "alpha", description, path: "/a" }]).split("\n")[1];

    expect((line ?? "").length).toBeLessThan(220);
    expect(line).toContain("`alpha`");
  });

  it("cuts a single enormous sentence down to the per-line cap", () => {
    const description = `${"a".repeat(200)}.`;
    const line = renderSkillsIndex([{ name: "alpha", description, path: "/a" }]).split("\n")[1];

    expect(line?.endsWith("…")).toBe(true);
    expect((line ?? "").length).toBeLessThan(180);
  });

  it("describes a skill whose header has no description", () => {
    expect(renderSkillsIndex([{ name: "alpha", description: "", path: "/a" }])).toContain(
      "(no description)",
    );
  });

  it("stops adding entries once the budget is spent", () => {
    const skills = Array.from({ length: 10 }, (_, index) => ({
      name: `skill-${index}`,
      description: "A description that takes some room. ".repeat(4),
      path: `/s${index}/SKILL.md`,
    }));

    const index = renderSkillsIndex(skills, 300);

    expect(index).toContain("more (list them with `list_skills`)");
    expect(index).not.toContain("`skill-9`");
  });
});

describe("renderSkillInvocation", () => {
  const skill: Skill = { name: "alpha", description: "", path: "/a/SKILL.md" };

  it("quotes the body and keeps the user's request separate", () => {
    const text = renderSkillInvocation(skill, "Do the thing.", "now");

    expect(text).toContain("The user invoked the `alpha` skill");
    expect(text).toContain("--- skill: alpha (/a/SKILL.md) ---");
    expect(text).toContain("Do the thing.");
    expect(text).toContain("User request: now");
  });

  it("says so when nothing followed the skill", () => {
    const text = renderSkillInvocation(skill, "Body.", "");

    expect(text).toContain("No request followed the skill");
    expect(text).not.toContain("User request:");
  });
});
