import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Mirrors everything written to stderr into a log file under
 * `$POLLINATIONS_HOME/logs`, so diagnostics survive after the process exits
 * (and are readable when the agent is launched by an editor that hides stderr).
 *
 * Each complete line is prefixed with an ISO timestamp in the file, so
 * interleaved sessions can be told apart after the fact.
 *
 * Returns the path of the log file that was opened.
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export class StderrLogger implements Logger {
  info(message: string): void {
    process.stderr.write(`${message}\n`);
  }
  warn(message: string): void {
    process.stderr.write(`${message}\n`);
  }
  error(message: string): void {
    process.stderr.write(`${message}\n`);
  }
  debug(message: string): void {
    process.stderr.write(`${message}\n`);
  }
}

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
      const stamp = new Date().toISOString();
      // Prefix every line (including the first) with the timestamp, but only
      // in the file: the terminal keeps the original, unadorned output.
      const stamped = text.replace(/^(.+)/gm, `[${stamp}] $1`);
      appendFileSync(logFile, stamped);
    } catch {
      // Logging must never take down the agent.
    }
    return originalWrite(chunk as string, encoding, callback);
  }) as typeof process.stderr.write;

  return logFile;
}