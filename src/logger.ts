import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Size at which the live log file is rotated away.
 *
 * The file used to grow without bound: the agent logs every turn, so a
 * long-lived session in an editor that never restarts it would eventually
 * fill the disk with its own diagnostics.
 */
const MAX_LOG_BYTES = 2 * 1024 * 1024;

/**
 * How many rotated generations to keep beside the live file.
 *
 * Small on purpose — old turns are the ones nobody reads, and keeping a
 * handful of generations is enough to look back past the current rotation.
 */
const ROTATED_LOG_FILES = 3;

/**
 * Mirrors everything written to stderr into a log file under
 * `$POLLINATIONS_HOME/logs`, so diagnostics survive after the process exits
 * (and are readable when the agent is launched by an editor that hides stderr).
 *
 * Each complete line is prefixed with an ISO timestamp in the file, so
 * interleaved sessions can be told apart after the fact.
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

/**
 * Mirrors every stderr write into `$POLLINATIONS_HOME/logs`, returning the
 * path of the file opened.
 *
 * `maxBytes` is the rotation ceiling: once the live file passes it, it is
 * shifted into `.1`, older generations are dropped, and counting starts over.
 * Production leaves the default; only tests shrink it, so a test does not have
 * to write two megabytes to watch a rotation happen.
 */
export function installFileLogger(home: string, maxBytes: number = MAX_LOG_BYTES): string {
  const logDir = join(home, "logs");
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, "pollinations-acp-server.log");

  // Started from the file's real size: a restart must not reset the budget and
  // let the file grow to twice the ceiling before the next rotation.
  let written = sizeOf(logFile);

  const rotate = () => {
    try {
      // Oldest generation first: `.3` is dropped, each survivor shifts up, and
      // the live file becomes `.1`.
      unlinkSync(`${logFile}.${ROTATED_LOG_FILES}`);
    } catch {
      // No generation that far back yet.
    }
    for (let generation = ROTATED_LOG_FILES - 1; generation >= 1; generation -= 1) {
      try {
        renameSync(`${logFile}.${generation}`, `${logFile}.${generation + 1}`);
      } catch {
        // A missing generation is the normal case until the file has rotated
        // this many times; keep going so the live file still gets moved.
      }
    }
    try {
      renameSync(logFile, `${logFile}.1`);
    } catch {
      // A live file that vanished mid-write is not worth failing over.
    }
    written = 0;
  };

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
      const bytes = Buffer.byteLength(stamped);
      // Rotate before writing when this line would push past the ceiling, so
      // the file never sits far above it. The `written > 0` guard keeps a
      // single oversized line from rotating an empty file forever.
      if (written > 0 && written + bytes > maxBytes) rotate();
      appendFileSync(logFile, stamped);
      written += bytes;
    } catch {
      // Logging must never take down the agent.
    }
    return originalWrite(chunk as string, encoding, callback);
  }) as typeof process.stderr.write;

  return logFile;
}

/** Current size of `path`, or 0 when it does not exist yet. */
function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}