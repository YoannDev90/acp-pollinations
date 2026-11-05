import { describe, expect, it } from "vitest";

import type { AgentContext } from "@agentclientprotocol/sdk";

import { connectionKey, createNotifier } from "../src/connection.js";

/** A stand-in for the SDK's context: `connectionKey` only inspects its shape. */
function asClient(value: unknown): AgentContext {
  return value as AgentContext;
}

describe("connectionKey", () => {
  it("gives one connection a stable key and two connections different ones", () => {
    const first = {};
    const second = {};

    expect(connectionKey(asClient(first))).toBe(connectionKey(asClient(first)));
    expect(connectionKey(asClient(first))).not.toBe(connectionKey(asClient(second)));
  });

  it("prefers the context object exposed by the SDK's symbol", () => {
    const symbol = Symbol("connectionContextOf");
    const context = {};
    const client = { [symbol]: () => context };

    // The symbol's own key, not the wrapper's, is what must be remembered.
    expect(connectionKey(asClient(client))).toBe(connectionKey(asClient(context)));
    expect(connectionKey(asClient(client))).not.toBe(connectionKey(asClient({})));
  });

  it("falls back to the wrapper when the symbol does not hold a function", () => {
    const symbol = Symbol("connectionContextOf");
    const client = { [symbol]: "not a function" };

    expect(connectionKey(asClient(client))).toBe(connectionKey(asClient(client)));
    expect(connectionKey(asClient(client))).not.toBe(connectionKey(asClient({})));
  });

  it("uses the `cx` property when the SDK exposes no symbol", () => {
    const context = {};

    expect(connectionKey(asClient({ cx: context }))).toBe(connectionKey(asClient(context)));
  });

  it("uses the client itself when neither symbol nor `cx` is present", () => {
    const client = {};

    expect(connectionKey(asClient(client))).toBe(connectionKey(asClient(client)));
    expect(connectionKey(asClient(client))).not.toBe(connectionKey(asClient({})));
  });

  it("survives a client with no prototype", () => {
    const client = Object.create(null) as object;

    expect(connectionKey(asClient(client))).toMatch(/^conn_/);
  });

  it("recovers from a client whose properties cannot be listed", () => {
    const withCx = new Proxy<{ cx?: unknown }>({}, {
      ownKeys() {
        throw new Error("no symbols for you");
      },
    });
    withCx.cx = { marker: "via-cx" };
    const withoutCx = new Proxy<Record<string, unknown>>({}, {
      ownKeys() {
        throw new Error("no symbols for you");
      },
    });

    // A hostile or exotic context must not take the request down with it.
    expect(connectionKey(asClient(withCx))).toBe(connectionKey(asClient(withCx.cx)));
    expect(connectionKey(asClient(withoutCx))).toMatch(/^conn_/);
    expect(connectionKey(asClient(withoutCx))).not.toBe(connectionKey(asClient(withCx)));
  });
});

describe("createNotifier", () => {
  it("forwards session updates to the client", async () => {
    const seen: unknown[] = [];
    const client = {
      notify: (_method: string, params: unknown) => {
        seen.push(params);
        return Promise.resolve();
      },
    };

    await createNotifier(asClient(client), "sess_1")({ session_id: "sess_1" } as never);

    expect(seen).toHaveLength(1);
  });

  it("swallows a client that disappeared mid-turn", async () => {
    const client = {
      notify: () => Promise.reject(new Error("connection closed")),
    };

    // The abort signal handles the rest; a dead client must not fail the turn.
    await expect(createNotifier(asClient(client), "sess_1")({} as never)).resolves.toBeUndefined();
  });
});
