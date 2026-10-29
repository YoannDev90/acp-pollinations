import { describe, expect, it } from "vitest";

import { createSseParser } from "../sse.js";

describe("createSseParser", () => {
  it("parses complete frames and keeps the trailing partial one", () => {
    const parser = createSseParser();

    const first = parser.push('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c":');
    expect(first.map((event) => event.data)).toEqual(['{"a":1}', '{"b":2}']);

    const second = parser.push('3}\n\n');
    expect(second.map((event) => event.data)).toEqual(['{"c":3}']);
  });

  it("reassembles a frame split across arbitrary chunk boundaries", () => {
    const parser = createSseParser();
    const wire = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n';

    const collected: string[] = [];
    for (let index = 0; index < wire.length; index += 1) {
      for (const event of parser.push(wire[index] as string)) collected.push(event.data);
    }
    for (const event of parser.flush()) collected.push(event.data);

    expect(collected).toEqual(['{"choices":[{"delta":{"content":"hello"}}]}', "[DONE]"]);
  });

  it("handles \\r\\n line endings and multi-line data fields", () => {
    const parser = createSseParser();
    const events = parser.push("event: chunk\r\ndata: line one\r\ndata: line two\r\n\r\n");

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: "chunk", data: "line one\nline two" });
  });

  it("ignores comments, id and retry fields", () => {
    const parser = createSseParser();
    const events = parser.push(": keep-alive\nid: 7\nretry: 1000\n\n");

    expect(events).toEqual([]);
  });

  it("strips exactly one leading space after the colon", () => {
    const parser = createSseParser();
    expect(parser.push("data:  spaced\n\n")[0]?.data).toBe(" spaced");
    expect(parser.push("data:spaced\n\n")[0]?.data).toBe("spaced");
  });

  it("flushes an unterminated trailing frame", () => {
    const parser = createSseParser();
    expect(parser.push("data: tail")).toEqual([]);
    expect(parser.flush().map((event) => event.data)).toEqual(["tail"]);
  });

  it("drops frames that carry no data field", () => {
    const parser = createSseParser();
    expect(parser.push("event: ping\n\n")).toEqual([]);
  });
});
