import { describe, expect, it } from "vitest";

import { StderrLogger } from "../src/logger.js";

describe("StderrLogger", () => {
  it("writes every level to stderr", () => {
    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: unknown) => {
      written.push(String(chunk));
      return true;
    };

    try {
      const logger = new StderrLogger();
      logger.info("info line");
      logger.warn("warn line");
      logger.error("error line");
      logger.debug("debug line");
    } finally {
      process.stderr.write = realWrite;
    }

    expect(written).toEqual(["info line\n", "warn line\n", "error line\n", "debug line\n"]);
  });
});
