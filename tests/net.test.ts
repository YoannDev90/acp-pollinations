import { describe, expect, it } from "vitest";

import { isRetryableStatus, retryDelayMs, sleep } from "../src/net.js";

/** A response carrying only the headers the backoff reads. */
function responseWith(headers: Record<string, string>): Response {
  return new Response(null, { headers });
}

describe("isRetryableStatus", () => {
  it("accepts the statuses a transient outage produces", () => {
    for (const status of [429, 502, 503, 504]) {
      expect(isRetryableStatus(status, "")).toBe(true);
    }
  });

  it("rejects the statuses a retry cannot change", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableStatus(status, "")).toBe(false);
    }
  });

  it("reads a rate limit out of the body when the status does not say it", () => {
    expect(isRetryableStatus(400, "Too Many Requests, slow down")).toBe(true);
    expect(isRetryableStatus(400, "invalid model id")).toBe(false);
  });
});

describe("retryDelayMs", () => {
  it("backs off exponentially and stops growing at eight seconds", () => {
    expect(retryDelayMs(undefined, 0)).toBe(1000);
    expect(retryDelayMs(undefined, 1)).toBe(2000);
    expect(retryDelayMs(undefined, 5)).toBe(8000);
    expect(retryDelayMs(undefined, 9)).toBe(8000);
  });

  it("honours a numeric Retry-After from the server", () => {
    expect(retryDelayMs(responseWith({ "retry-after": "2" }), 0)).toBe(2000);
    // A server asking for a negative or absurd wait is not obeyed literally.
    expect(retryDelayMs(responseWith({ "retry-after": "-5" }), 0)).toBe(0);
    expect(retryDelayMs(responseWith({ "retry-after": "600" }), 0)).toBe(30_000);
  });

  it("honours an HTTP-date Retry-After", () => {
    const soon = new Date(Date.now() + 5_000).toUTCString();
    const delay = retryDelayMs(responseWith({ "retry-after": soon }), 0);

    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(5_000);
  });

  it("falls back to the backoff when Retry-After is unusable", () => {
    expect(retryDelayMs(responseWith({ "retry-after": "whenever" }), 0)).toBe(1000);
  });
});

describe("sleep", () => {
  it("waits out the delay", async () => {
    await expect(sleep(5)).resolves.toBeUndefined();
  });

  it("rejects as soon as the signal aborts", async () => {
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow("aborted");
  });

  it("rejects immediately for a signal already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(sleep(10_000, controller.signal)).rejects.toThrow("aborted");
  });
});
