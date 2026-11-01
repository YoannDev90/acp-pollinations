> ## Documentation Index
> Fetch the complete documentation index at: https://agentclientprotocol.com/llms.txt
> Use this file to discover all available pages before exploring further.

# File System

> Client filesystem access methods

The filesystem methods allow Agents to read and write text files within the Client's environment. These methods enable Agents to access unsaved editor state and allow Clients to track file modifications made during agent execution.

## Checking support

Before attempting to use filesystem methods, Agents **MUST** verify that the Client supports these capabilities by checking the [Client Capabilities](https://agentclientprotocol.com/protocol/v1/initialization.md#client-capabilities) field in the Client's `initialize` request:

```json highlight={9,10} theme={null}
{
  "jsonrpc": "2.0",
  "id": 0,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {
      "fs": {
        "readTextFile": true,
        "writeTextFile": true
      }
    }
  }
}
```

If `readTextFile` or `writeTextFile` is `false` or not present, the Agent **MUST NOT** attempt to call the corresponding filesystem method.

## Reading files

The `fs/read_text_file` method allows Agents to read text file contents from the Client's filesystem, including unsaved changes in the editor.

```json theme={null}
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "fs/read_text_file",
  "params": {
    "sessionId": "sess_abc123def456",
    "path": "/home/user/project/src/main.py",
    "line": 10,
    "limit": 50
  }
}
```

**sessionId** `SessionId` *required*

The [Session ID](https://agentclientprotocol.com/protocol/v1/session-setup.md#session-id) for this request. The
session determines which filesystem roots are in scope for the path.

**path** `string` *required*

Absolute path to the file to read

**line** `number`

Optional line number to start reading from (1-based)

**limit** `number`

Optional maximum number of lines to read

The Client responds with the file contents:

```json theme={null}
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": "def hello_world():\n    print('Hello, world!')\n"
  }
}
```

## Writing files

The `fs/write_text_file` method allows Agents to write or update text files in the Client's filesystem.

```json theme={null}
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "fs/write_text_file",
  "params": {
    "sessionId": "sess_abc123def456",
    "path": "/home/user/project/config.json",
    "content": "{\n  \"debug\": true,\n  \"version\": \"1.0.0\"\n}"
  }
}
```

**sessionId** `SessionId` *required*

The [Session ID](https://agentclientprotocol.com/protocol/v1/session-setup.md#session-id) for this request. The
session determines which filesystem roots are in scope for the path.

**path** `string` *required*

Absolute path to the file to write.

The Client **MUST** create the file if it doesn't exist.

**content** `string` *required*

The text content to write to the file

The Client responds with an empty result on success:

```json theme={null}
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {}
}
```

## Security

The Client performs these operations itself, so it is responsible for checking them. A permission request from the Agent does not replace the Client's own checks.

* Clients **SHOULD** check requested paths against the session's [root set](https://agentclientprotocol.com/protocol/v1/session-setup.md#workspace-root-security) at the time of use, and deny the request or ask the user outside them.
* Clients **SHOULD** ask the user before `fs/write_text_file` changes files that control execution or approval, such as version-control hooks, editor or Agent settings, and MCP configuration.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.