> ## Documentation Index
> Fetch the complete documentation index at: https://agentclientprotocol.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Tool Calls

> How Agents report tool call execution

Tool calls are actions the language model asks the Agent to perform during a [prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn.md), such as reading a file or running a command. The Agent executes them on the model's behalf.

Agents report tool calls through [`session/update`](https://agentclientprotocol.com/protocol/v1/prompt-turn#3-agent-reports-output) notifications, which Clients use to show progress and results to users.

Agents may use Client capabilities such as [permission requests](#requesting-permission) and [file system access](https://agentclientprotocol.com/protocol/v1/file-system.md) while running a tool call.

## Creating

When the language model requests a tool invocation, the Agent **SHOULD** report it to the Client:

```json theme={null}
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123def456",
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "call_001",
      "title": "Reading configuration file",
      "name": "read_file",
      "kind": "read",
      "status": "pending"
    }
  }
}
```

**toolCallId** `ToolCallId` *required*

A unique identifier for this tool call within the session

**title** `string` *required*

A human-readable title describing what the tool is doing

**name** `string`

The programmatic name of the invoked tool, such as `read_file`. This
identifies which tool is being used. `title` describes this invocation for
users, while `kind` provides a coarse presentation category. If omitted or
`null` on the initial tool call, no name is provided. Names are opaque,
informational metadata and do not advertise a capability or grant
authorization. Agents **SHOULD** include the name when available and **SHOULD
NOT** change it later except to correct metadata.

**kind** `ToolKind`

The category of tool being invoked.

**kinds**

* `read` - Reading files or data
* `edit` - Modifying files or content
* `delete` - Removing files or data
* `move` - Moving or renaming files
* `search` - Searching for information
* `execute` - Running commands or code
* `think` - Internal reasoning or planning
* `fetch` - Retrieving external data
* `switch_mode` - Switching the session mode
* `other` - Other tool types (default)

Tool kinds help Clients choose appropriate icons and optimize how they display tool execution progress.

**status** `ToolCallStatus`

The current [execution status](#status) (defaults to `pending`)

**content** `ToolCallContent[]`

[Content produced](#content) by the tool call

**locations** `ToolCallLocation[]`

[File locations](#following-the-agent) affected by this tool call

**rawInput** `unknown`

The raw input sent to the tool. Any JSON value is accepted, including objects,
arrays, strings, numbers, booleans, and `null`.

**rawOutput** `unknown`

The raw output returned by the tool. Any JSON value is accepted, including
objects, arrays, strings, numbers, booleans, and `null`.

Omission and `null` are equivalent for `rawInput` and `rawOutput`.
On an initial tool call, both mean no value is provided. On a tool call
update, both leave the previously reported value unchanged.

## Updating

As tools execute, Agents send updates to report progress and results.

Updates use the `session/update` notification with `tool_call_update`:

```json theme={null}
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123def456",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call_001",
      "status": "in_progress",
      "content": [
        {
          "type": "content",
          "content": {
            "type": "text",
            "text": "Found 3 configuration files..."
          }
        }
      ]
    }
  }
}
```

All fields except `toolCallId` are optional in updates. Only the fields being changed need to be included.

For `name`, a string sets or replaces the tool name. Omission and `null` both
leave the existing name unchanged, so ACP v1 cannot clear a previously reported
name.

## Requesting permission

The Agent **MAY** request permission from the user before executing a tool call by calling the `session/request_permission` method:

```json theme={null}
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session/request_permission",
  "params": {
    "sessionId": "sess_abc123def456",
    "toolCall": {
      "toolCallId": "call_001"
    },
    "options": [
      {
        "optionId": "allow-once",
        "name": "Allow once",
        "kind": "allow_once"
      },
      {
        "optionId": "reject-once",
        "name": "Reject",
        "kind": "reject_once"
      }
    ]
  }
}
```

**sessionId** `SessionId` *required*

The session ID for this request

**toolCall** `ToolCallUpdate` *required*

The tool call update containing details about the operation

**options** `PermissionOption[]` *required*

Available [permission options](#permission-options) for the user to choose
from

The Client responds with the user's decision:

```json theme={null}
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "outcome": {
      "outcome": "selected",
      "optionId": "allow-once"
    }
  }
}
```

Clients **MAY** automatically allow or reject permission requests according to the user settings.

If the current prompt turn gets [cancelled](https://agentclientprotocol.com/protocol/v1/prompt-turn.md#cancellation), the Client **MUST** respond with the `"cancelled"` outcome:

```json theme={null}
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "outcome": {
      "outcome": "cancelled"
    }
  }
}
```

**outcome** `RequestPermissionOutcome` *required*

The user's decision, either: - `cancelled` - The [prompt turn was
cancelled](https://agentclientprotocol.com/protocol/v1/prompt-turn.md#cancellation) - `selected` with an
`optionId` - The ID of the selected permission option

### Permission options

Each permission option provided to the Client contains:

**optionId** `string` *required*

Unique identifier for this option

**name** `string` *required*

Human-readable label to display to the user

**kind** `PermissionOptionKind` *required*

A hint to help Clients choose appropriate icons and UI treatment for each option.

* `allow_once` - Allow this operation only this time
* `allow_always` - Allow this operation and remember the choice
* `reject_once` - Reject this operation only this time
* `reject_always` - Reject this operation and remember the choice

The Agent owns remembered decisions. When the user selects an `allow_always` or
`reject_always` option, the Agent stores the decision, decides its scope (for
example a tool, a command, or a directory) and how long it lasts, and applies
it by not asking again. `kind` is only a UI hint. The option `name` describes
the scope.

### Security

* Clients **SHOULD** describe the operation from the tool call's `kind`, `locations`, and content, present `title` as Agent-authored text, and show commands and paths in full.
* Agents **SHOULD NOT** give an option a `name` that contradicts its `kind`, and **SHOULD** act on a selected option according to its known `kind`.
* Automatic approval **SHOULD NOT** rely only on `title` or option `name`.
* Agents **SHOULD NOT** treat an outcome they don't recognize as approval.
* Agents **SHOULD** perform only the operation the approved request described, and **SHOULD** request again if the command or resolved target changes.
* Agents **SHOULD** state the scope of a remembered decision (`allow_always`, `reject_always`) in the option `name` and **SHOULD NOT** apply it beyond that scope.
* Agents **SHOULD NOT** switch to a mode or configuration that reduces user oversight without user action.

## Status

Tool calls progress through different statuses during their lifecycle:

**pending**

The tool call hasn't started running yet because the input is either streaming
or awaiting approval

**in\_progress**

The tool call is currently running

**completed**

The tool call completed successfully

**failed**

The tool call failed with an error

## Content

Tool calls can produce different types of content:

### Regular content

Standard [content blocks](https://agentclientprotocol.com/protocol/v1/content.md) like text, images, or resources:

```json theme={null}
{
  "type": "content",
  "content": {
    "type": "text",
    "text": "Analysis complete. Found 3 issues."
  }
}
```

### Diffs

File modifications shown as diffs:

```json theme={null}
{
  "type": "diff",
  "path": "/home/user/project/src/config.json",
  "oldText": "{\n  \"debug\": false\n}",
  "newText": "{\n  \"debug\": true\n}"
}
```

**path** `string` *required*

The absolute file path being modified

**oldText** `string`

The original content (null for new files)

**newText** `string` *required*

The new content after modification

### Terminals

Live terminal output from command execution:

```json theme={null}
{
  "type": "terminal",
  "terminalId": "term_xyz789"
}
```

**terminalId** `string` *required*

The ID of a terminal created with `terminal/create`

When a terminal is embedded in a tool call, the Client displays live output as it's generated and continues to display it even after the terminal is released.

> [card]
>
> Learn more about Terminals
>
> [Open](https://agentclientprotocol.com/protocol/v1/terminals.md)

## Following the Agent

Tool calls can report the file locations they're working with. Clients can use this to follow along, showing which files the Agent is reading or modifying as it works.

```json theme={null}
{
  "path": "/home/user/project/src/main.py",
  "line": 42
}
```

**path** `string` *required*

The absolute file path being accessed or modified

**line** `integer | null`

Optional 1-based line number within the file, represented as an unsigned
32-bit integer. Omission and `null` are equivalent and mean no specific line
was provided.

Locations are display metadata and do not grant file access. Clients **SHOULD NOT** automatically open locations outside the session's [root set](https://agentclientprotocol.com/protocol/v1/session-setup.md#workspace-root-security).


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.