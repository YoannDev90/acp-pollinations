import { methods } from "@agentclientprotocol/sdk";
import type { AgentContext, SessionUpdate } from "@agentclientprotocol/sdk";

/** Identifies the connection a request arrived on, for per-connection state. */
const connectionIds = new WeakMap<object, string>();
let connectionCounter = 0;

export function connectionKey(client: AgentContext): string {
  let identity: object = client as object;
  try {
    const symbol = [
      ...Object.getOwnPropertySymbols(client),
      ...Object.getOwnPropertySymbols(Object.getPrototypeOf(client) ?? {}),
    ].find((candidate) => candidate.toString().includes("connectionContextOf"));
    if (symbol) {
      const context = (client as unknown as Record<symbol, () => unknown>)[symbol];
      if (typeof context === "function") identity = context.call(client) as object;
    } else {
      identity = ((client as unknown as { cx?: unknown }).cx ?? client) as object;
    }
  } catch {
    identity = ((client as unknown as { cx?: unknown }).cx ?? client) as object;
  }

  let key = connectionIds.get(identity);
  if (!key) {
    key = `conn_${(connectionCounter += 1)}`;
    connectionIds.set(identity, key);
  }
  return key;
}

export function createNotifier(
  client: AgentContext,
  sessionId: string,
): (update: SessionUpdate) => Promise<void> {
  return async (update) => {
    try {
      await client.notify(methods.client.session.update, { sessionId, update });
    } catch {
      // The client disappeared mid-turn; the abort signal handles the rest.
    }
  };
}