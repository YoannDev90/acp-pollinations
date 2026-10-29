import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates an isolated working directory for a test.
 *
 * `/tmp/opencode` is preferred when present: the harness pre-creates it for
 * agent work, so tests stay inside the approved scratch area.
 */
export async function createTmpDir(prefix: string): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> {
  const base = process.env.ACP_TEST_TMP ?? "/tmp/opencode";
  let safeBase = base;
  try {
    await stat(base);
  } catch {
    safeBase = tmpdir();
  }

  const path = await mkdtemp(join(safeBase, `${prefix}-`));
  return {
    path,
    cleanup: () => rm(path, { recursive: true, force: true }),
  };
}
