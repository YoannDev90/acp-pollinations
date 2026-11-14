import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Agent Skills the agent found on this machine.
 *
 * The wire name is the directory name unless the frontmatter says otherwise:
 * it is what a client shows in a command palette and what `read_skill`
 * resolves, so it has to be stable across the two.
 */
export type Skill = {
  /** Frontmatter `name`, falling back to the directory name. */
  name: string;
  /** Frontmatter `description`, collapsed to one line; empty when absent. */
  description: string;
  /** Absolute path of the `SKILL.md` that defines the skill. */
  path: string;
};

/** File that makes a directory a skill, per the Agent Skills convention. */
export const SKILL_FILE_NAME = "SKILL.md";

/**
 * Where skills live relative to a root, in precedence order.
 *
 * Both spellings are in use on the same machines — `.agents` is the
 * tool-neutral one, `.claude` is what Claude Code writes — so scanning only
 * one would silently miss half of an installed set.
 */
const SKILL_SUBDIRECTORIES: ReadonlyArray<readonly [string, string]> = [
  [".agents", "skills"],
  [".claude", "skills"],
];

/** Ceiling on discovered skills, so one huge root cannot flood the prompt. */
const MAX_SKILLS = 200;
/** Descriptions are quoted verbatim in the system prompt and in `available_commands_update`. */
const MAX_DESCRIPTION_CHARS = 400;
/** One skill must not be able to fill a context window on its own. */
const MAX_SKILL_BODY_CHARS = 40_000;
/** Per-line cap for a description shown in the system prompt index. */
const MAX_SUMMARY_CHARS = 160;
/** Default size of the system-prompt index; the rest is reachable via `list_skills`. */
const DEFAULT_INDEX_BUDGET = 6_000;

/**
 * Skill roots for a session: the workspace roots first, then the user's home.
 *
 * Workspace roots come first because a project that ships its own copy of a
 * skill means to override the installed one, and discovery keeps the first
 * occurrence of a name.
 */
export function defaultSkillRoots(
  workspaceRoots: readonly string[],
  home: string = homedir(),
): string[] {
  const roots: string[] = [];
  for (const workspaceRoot of workspaceRoots) {
    for (const [directory, subdirectory] of SKILL_SUBDIRECTORIES) {
      roots.push(join(workspaceRoot, directory, subdirectory));
    }
  }
  for (const [directory, subdirectory] of SKILL_SUBDIRECTORIES) {
    roots.push(join(home, directory, subdirectory));
  }
  return [...new Set(roots)];
}

/**
 * Reads every `SKILL.md` under `roots`, newest root first.
 *
 * A root that does not exist, a directory without a `SKILL.md`, and a file
 * that cannot be read are all normal — a skill set is optional by nature, so
 * none of them is reported as an error. Discovery only ever degrades to
 * "fewer skills".
 */
export async function discoverSkills(roots: readonly string[]): Promise<Skill[]> {
  const skills: Skill[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    if (skills.length >= MAX_SKILLS) break;

    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (skills.length >= MAX_SKILLS) break;
      // Dot-directories inside a skill root are tooling state, not skills;
      // symlinked directories are how plugin stores install skills.
      if (entry.name.startsWith(".") || !(entry.isDirectory() || entry.isSymbolicLink())) continue;

      const path = join(root, entry.name, SKILL_FILE_NAME);
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch {
        continue;
      }

      const metadata = parseSkillMetadata(text);
      const name = metadata.name?.trim() || entry.name;
      if (seen.has(name)) continue;
      seen.add(name);

      skills.push({
        name,
        description: oneLine(metadata.description ?? "").slice(0, MAX_DESCRIPTION_CHARS),
        path,
      });
    }
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Extracts the scalar fields of a YAML frontmatter block.
 *
 * Only the subset an Agent Skills header uses is understood: plain scalars,
 * quoted scalars, folded (`>`) and literal (`|`) block scalars, and plain
 * scalars continued on an indented line. Anything else yields the fields that
 * did parse — a skill with an exotic header still loads, with an empty
 * description.
 */
export function parseSkillMetadata(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};

  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && (line.trim() === "---" || line.trim() === "...")) {
      end = index;
      break;
    }
  }
  if (end === -1) return {};

  const metadata: Record<string, string> = {};
  let currentKey: string | null = null;

  for (let index = 1; index < end; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;

    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!match) {
      // A plain scalar may continue on the next, more indented line.
      if (currentKey && /^[ \t]+\S/.test(line)) {
        metadata[currentKey] = `${metadata[currentKey] ?? ""} ${line.trim()}`.trim();
      }
      continue;
    }

    const key = match[1];
    const value = (match[2] ?? "").trim();
    if (key === undefined) continue;

    // An explicit block indicator owns the indented lines that follow it.
    if (/^[>|][+-]?\d*$/.test(value)) {
      const { lines: block, next } = collectBlock(lines, index + 1, end);
      index = next - 1;
      metadata[key] = value.startsWith("|") ? block.join("\n").trim() : foldBlock(block);
      currentKey = null;
      continue;
    }

    metadata[key] = unquote(value);
    // An empty value opens a nested mapping rather than a scalar, so nothing
    // continues it; a plain scalar may carry on over the next indented line.
    currentKey = value === "" ? null : key;
  }

  return metadata;
}

/**
 * Drops the frontmatter so a skill body can be handed to the model as-is.
 *
 * A file without a header is returned whole: the body is what matters, and
 * refusing to load it would turn a formatting slip into a missing skill.
 */
export function stripFrontmatter(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return text.trim();

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && (line.trim() === "---" || line.trim() === "...")) {
      return lines.slice(index + 1).join("\n").trim();
    }
  }
  return text.trim();
}

/** Reads a skill's instructions, capped so one skill cannot flood a turn. */
export async function readSkillBody(skill: Skill): Promise<string> {
  const body = stripFrontmatter(await readFile(skill.path, "utf8"));
  if (body.length <= MAX_SKILL_BODY_CHARS) return body;
  return `${body.slice(0, MAX_SKILL_BODY_CHARS)}\n… (truncated)`;
}

/**
 * Resolves a skill by name, tolerating the case a client or a user types.
 *
 * Command palettes lowercase, and a mismatch there would look like a skill
 * that is installed but unusable.
 */
export function findSkill(skills: readonly Skill[], name: string): Skill | undefined {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return undefined;
  return (
    skills.find((skill) => skill.name.toLowerCase() === wanted) ??
    skills.find((skill) => skill.name.toLowerCase() === wanted.replace(/^\/+/, ""))
  );
}

/**
 * A skill name that is safe to advertise as an ACP slash command.
 *
 * Clients render these in a palette and echo them back as `/name`, so a name
 * with spaces, slashes, or a leading digit would either be mangled or refused.
 */
export function isSkillCommandName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name);
}

/** Description a skill is advertised and listed under. */
export function skillCommandDescription(skill: Skill): string {
  const description = oneLine(skill.description).trim();
  return description || `Skill ${skill.name}`;
}

/**
 * The system-prompt index of installed skills.
 *
 * The model has to know a skill exists before it can ask for it, and the
 * descriptions are long, so each entry is summarised and the whole index is
 * budgeted: what does not fit is reachable through `list_skills` instead of
 * costing every request for the rest of the session.
 */
export function renderSkillsIndex(
  skills: readonly Skill[],
  budget: number = DEFAULT_INDEX_BUDGET,
): string {
  if (skills.length === 0) return "";

  const header =
    "Skills installed for this session (load one with `read_skill` before following it):";
  const lines: string[] = [];
  let used = header.length;

  for (const skill of skills) {
    const line = `- \`${skill.name}\`: ${summarize(skill.description)}`;
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }

  const omitted = skills.length - lines.length;
  const tail = omitted > 0 ? `\n- …and ${omitted} more (list them with \`list_skills\`)` : "";
  return `${[header, ...lines].join("\n")}${tail}`;
}

/**
 * What the model receives when the user types `/skill-name`.
 *
 * The body is quoted as data rather than merged into the request, so a skill
 * cannot silently rewrite what the user asked for.
 */
export function renderSkillInvocation(skill: Skill, body: string, request: string): string {
  return [
    `The user invoked the \`${skill.name}\` skill. Follow its instructions for this turn.`,
    `--- skill: ${skill.name} (${skill.path}) ---`,
    body,
    "---",
    request
      ? `User request: ${request}`
      : "No request followed the skill; apply it and say what you are doing.",
  ].join("\n\n");
}

/** Reads the indented block that follows a block scalar or an empty value. */
function collectBlock(
  lines: readonly string[],
  start: number,
  end: number,
): { lines: string[]; next: number } {
  const block: string[] = [];
  let index = start;
  while (index < end) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      block.push("");
      index += 1;
      continue;
    }
    if (!/^[ \t]/.test(line)) break;
    block.push(line);
    index += 1;
  }

  const indent = block.find((line) => line.trim() !== "")?.match(/^[ \t]*/)?.[0].length ?? 0;
  return {
    lines: block.map((line) => line.slice(indent)),
    next: index,
  };
}

/** YAML's folded scalar: every line break becomes a space. */
function foldBlock(lines: readonly string[]): string {
  return lines
    .filter((line) => line.trim() !== "")
    .map((line) => line.trim())
    .join(" ")
    .trim();
}

function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if (first === last && (first === '"' || first === "'")) return value.slice(1, -1);
  return value;
}

/** Collapses whitespace so a description can be printed on one line. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** First sentence of a description, short enough to sit in a prompt index. */
function summarize(description: string): string {
  const text = oneLine(description);
  if (!text) return "(no description)";
  if (text.length <= MAX_SUMMARY_CHARS) return text;

  const sentence = /^(.{40,}?[.!?])(\s|$)/.exec(text);
  const cut = sentence?.[1] ?? text.slice(0, MAX_SUMMARY_CHARS);
  return cut.length > MAX_SUMMARY_CHARS ? `${cut.slice(0, MAX_SUMMARY_CHARS - 1)}…` : cut;
}
