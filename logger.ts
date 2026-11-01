import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Mirrors everything written to stderr into a log file under
 * `$POLLINATIONS_HOME/logs`, so diagnostics survive after the process exits
 * (and are readable when the agent is launched by an editor that hides stderr).
 *
 * Returns the path of the log file that was opened.
 */
export function installFileLogger(home: string): string {
  const logDir = join(home, "logs");
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, "pollinations-acp-server.log");

  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, encoding?: BufferEncoding, callback?: (error?: Error | null) => void) => {
    try {
      const text =
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk as ArrayBufferLike).toString(encoding ?? "utf8");
      appendFileSync(logFile, text);
    } catch {
      // Logging must never take down the agent.
    }
    return originalWrite(chunk as string, encoding, callback);
  }) as typeof process.stderr.write;

  return logFile;
}