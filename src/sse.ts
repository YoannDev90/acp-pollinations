/** A single parsed Server-Sent Events frame. */
export type SseEvent = {
  /** Event name from the `event:` field, if any. */
  event?: string;
  /** Joined payload from every `data:` field in the frame. */
  data: string;
};

/**
 * Incremental Server-Sent Events parser.
 *
 * Feed it decoded text chunks as they arrive; it returns every complete frame
 * contained in the buffer and keeps the trailing partial frame for the next
 * call. Handles both `\n` and `\r\n` line endings, comments, and multi-line
 * `data:` fields.
 */
export function createSseParser(): {
  push(chunk: string): SseEvent[];
  flush(): SseEvent[];
} {
  let buffer = "";

  const parseFrame = (frame: string): SseEvent | null => {
    const dataLines: string[] = [];
    let event: string | undefined;

    // Split on \n and drop a trailing \r so CRLF frames parse identically to LF.
    for (const rawLine of frame.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === "" || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator === -1 ? line : line.slice(0, separator);
      // Per the SSE spec, a single leading space after the colon is stripped.
      const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");

      if (field === "data") dataLines.push(value);
      else if (field === "event") event = value;
      // `id:` and `retry:` are irrelevant for a stateless JSON-RPC stream.
    }

    if (dataLines.length === 0) return null;
    return event === undefined ? { data: dataLines.join("\n") } : { event, data: dataLines.join("\n") };
  };

  const drain = (): SseEvent[] => {
    const events: SseEvent[] = [];

    for (;;) {
      // A frame ends at a blank line; accept \r\n too.
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) break;

      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);

      const event = parseFrame(frame);
      if (event) events.push(event);
    }

    return events;
  };

  return {
    push(chunk: string): SseEvent[] {
      buffer += chunk;
      return drain();
    },
    flush(): SseEvent[] {
      const events = drain();
      if (buffer.trim() === "") {
        buffer = "";
        return events;
      }

      const trailing = parseFrame(buffer);
      buffer = "";
      return trailing ? [...events, trailing] : events;
    },
  };
}
