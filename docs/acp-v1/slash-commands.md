> ## Documentation Index
> Fetch the complete documentation index at: https://agentclientprotocol.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Slash Commands

> Advertise available slash commands to clients

Agents can advertise a set of slash commands that users can invoke. These commands provide quick access to specific agent capabilities and workflows. Commands are run as part of regular [prompt](https://agentclientprotocol.com/protocol/v1/prompt-turn.md) requests where the Client includes the command text in the prompt.

## Advertising commands

After creating a session, the Agent **MAY** send a list of available commands via the `available_commands_update` session notification:

```json theme={null}
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123def456",
    "update": {
      "sessionUpdate": "available_commands_update",
      "availableCommands": [
        {
          "name": "web",
          "description": "Search the web for information",
          "input": {
            "hint": "query to search for"
          }
        },
        {
          "name": "test",
          "description": "Run tests for the current project"
        },
        {
          "name": "plan",
          "description": "Create a detailed implementation plan",
          "input": {
            "hint": "description of what to plan"
          }
        }
      ]
    }
  }
}
```

**availableCommands** `AvailableCommand[]`

The list of commands available in this session

### AvailableCommand

**name** `string` *required*

The command name (e.g., "web", "test", "plan")

**description** `string` *required*

Human-readable description of what the command does

**input** `AvailableCommandInput`

Optional input specification for the command

### AvailableCommandInput

Currently supports unstructured text input:

**hint** `string` *required*

A hint to display when the input hasn't been provided yet

## Dynamic updates

The Agent can update the list of available commands at any time during a session by sending another `available_commands_update` notification. Agents can use this to add commands as context changes, remove commands that no longer apply, or update descriptions.

## Running commands

Commands are included as regular user messages in prompt requests:

```json theme={null}
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/prompt",
  "params": {
    "sessionId": "sess_abc123def456",
    "prompt": [
      {
        "type": "text",
        "text": "/web agent client protocol"
      }
    ]
  }
}
```

The Agent recognizes the command prefix and processes it accordingly. Commands may be accompanied by any other user message content types (images, audio, etc.) in the same prompt array.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.