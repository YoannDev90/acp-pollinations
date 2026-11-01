import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Mirrors everything written to stderr into a log file under
 * `$POLLINATIONS_HOME/logs`, so diagnostics survive after the process exits
 * (and are readable when the agent is launched by an editor that hides stderr).
 *
 * Returns the path of the log file that was opened.
 */

// Process-global state so that repeated calls to `installFileLogger` redirect
// the single wrapped `stderr.write` instead of stacking wrappers (which would
// otherwise append every line to every previously opened log file).
let originalWrite: ((...args: unknown[]) => unknown) | null = null;
let activeLogFile: string | null = null;
let fileLoggingEnabled = false;

export function installFileLogger(home: string): string {
  const logDir = join(home, "logs");
  const logFile = join(logDir, "pollinations-acp-server.log");

  let enabled = true;
  try {
    mkdirSync(logDir, { recursive: true });
    // Touch the file so it exists even before the first write, matching the
    // documented "created on startup" behaviour.
    appendFileSync(logFile, "");
  } catch {
    enabled = false;
  }

  activeLogFile = logFile;
  fileLoggingEnabled = enabled;

  if (originalWrite === null) {
    const bound = process.stderr.write.bind(process.stderr);
    originalWrite = bound as (...args: unknown[]) => unknown;

    process.stderr.write = ((
      chunk: unknown,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      // `Writable.write` accepts both `write(chunk, cb)` and
      // `write(chunk, encoding, cb)`; tell them apart so callbacks are
      // actually invoked (otherwise callers waiting on the write hang forever).
      let encoding: BufferEncoding | undefined;
      let cb: ((error?: Error | null) => void) | undefined;
      if (typeof encodingOrCallback === "function") {
        cb = encodingOrCallback;
      } else if (typeof encodingOrCallback === "string") {
        encoding = encodingOrCallback;
        cb = callback;
      } else {
        // Tolerate null/undefined/non-string encodings the way Node does.
        cb = (typeof callback === "function" ? callback : undefined) as
          ((error?: Error | null) => void) | undefined;
      }

      if (fileLoggingEnabled && activeLogFile !== null) {
        try {
          // Mirror the exact bytes the process writes, honouring the
          // encoding Node applies to string chunks (so a `hex`/`base64`
          // payload is decoded rather than echoed verbatim).
          const data =
            typeof chunk === "string"
              ? Buffer.from(chunk, encoding ?? "utf8")
              : chunk instanceof ArrayBuffer
                ? Buffer.from(chunk)
                : ArrayBuffer.isView(chunk)
                  ? Buffer.from(
                      chunk.buffer,
                      chunk.byteOffset,
                      chunk.byteLength,
                    )
                  : (chunk as Buffer | Uint8Array);
          appendFileSync(activeLogFile, data);
        } catch {
          // Logging must never take down the agent.
          fileLoggingEnabled = false;
        }
      }

      if (encoding === undefined && cb !== undefined) {
        return Boolean(originalWrite!(chunk, cb));
      }
      if (encoding !== undefined && cb !== undefined) {
        return Boolean(originalWrite!(chunk, encoding, cb));
      }
      if (encoding !== undefined) {
        return Boolean(originalWrite!(chunk, encoding));
      }
      return Boolean(originalWrite!(chunk));
    }) as typeof process.stderr.write;
  }

  return logFile;
}
