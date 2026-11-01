> ## Documentation Index
> Fetch the complete documentation index at: https://agentclientprotocol.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Session Delete

> Removing sessions from session history

The `session/delete` method lets Clients remove sessions from an Agent's `session/list` results, so users can clean up session history from any ACP Client.

Before deleting sessions, Clients **MUST** first complete the [initialization](https://agentclientprotocol.com/protocol/v1/initialization.md) phase and verify the Agent supports this capability.

```mermaid theme={null}
sequenceDiagram
    participant Client
    participant Agent

    Note over Agent,Client: Initialized

    Client->>Agent: session/list
    Agent-->>Client: session/list response (sessions)

    alt User deletes a session
        Client->>Agent: session/delete (sessionId)
        Agent-->>Client: session/delete response
    end

    Client->>Agent: session/list
    Agent-->>Client: session/list response (without deleted session)
```

## Checking support

Before attempting to delete a session, Clients **MUST** verify that the Agent supports this capability by checking the `sessionCapabilities.delete` field in the `initialize` response:

```json highlight={7-9} theme={null}
{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "protocolVersion": 1,
    "agentCapabilities": {
      "sessionCapabilities": {
        "delete": {}
      }
    }
  }
}
```

If `sessionCapabilities.delete` is omitted or `null`, the Agent does not support deleting sessions and Clients **MUST NOT** attempt to call `session/delete`. Supplying `{}` means the Agent supports the method.

## Deleting a session

Clients delete a session by calling `session/delete` with the session ID to remove from session history:

```json theme={null}
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/delete",
  "params": {
    "sessionId": "sess_abc123def456"
  }
}
```

**sessionId** `SessionId` *required*

Unique identifier for the session to delete.

On success, the Agent returns an empty result:

```json theme={null}
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {}
}
```

## Semantics

* Deleted sessions no longer appear in future `session/list` results.
* Deleting an already-deleted session, or a session that never existed, **SHOULD** succeed silently.
* Clients **SHOULD** treat a `-32002` response to `session/delete` as a successful delete.
* Agents may implement soft delete or hard delete. ACP only specifies the user-facing session-list behavior.
* Behavior for `session/load` on a deleted session is implementation-defined.
* Behavior for deleting an active session is implementation-defined.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.