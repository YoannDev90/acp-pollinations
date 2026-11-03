import { realpath } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";

import { ToolError } from "./errors.js";

/** Resolves a path and enforces the session's workspace root set. */
export async function resolveInRoots(path: unknown, ctx: {
  cwd: string;
  roots: string[];
}): Promise<string> {
  if (typeof path !== "string" || path.trim() === "") {
    throw new ToolError("A non-empty `path` is required");
  }

  const absolute = resolve(ctx.cwd, path);

  const lexicallyAllowed = ctx.roots.some((root) => {
    const base = resolve(root);
    return absolute === base || absolute.startsWith(base.endsWith(sep) ? base : base + sep);
  });
  if (!lexicallyAllowed) {
    throw new ToolError(
      `Refusing to access ${absolute}: it is outside the session workspace (${ctx.roots.join(", ")})`,
    );
  }

  const realRoots = await Promise.all(
    ctx.roots.map(async (root) => {
      try {
        return await realpath(resolve(root));
      } catch {
        return resolve(root);
      }
    }),
  );

  let realAbsolute: string;
  try {
    realAbsolute = await realpath(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    try {
      const parent = await realpath(dirname(absolute));
      realAbsolute = resolve(parent, basename(absolute));
    } catch {
      return absolute;
    }
  }

  const reallyAllowed = realRoots.some((root) => {
    return realAbsolute === root || realAbsolute.startsWith(root.endsWith(sep) ? root : root + sep);
  });
  if (!reallyAllowed) {
    throw new ToolError(
      `Refusing to access ${absolute}: it resolves outside the session workspace (${ctx.roots.join(", ")})`,
    );
  }

  return absolute;
}