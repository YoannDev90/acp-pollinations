> ## Documentation Index
> Fetch the complete documentation index at: https://agentclientprotocol.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Agent Plan

> How Agents communicate their execution plans

A plan is the Agent's list of steps for a multi-step task. Each entry has a description, a priority, and a status.

Agents may send plans to Clients through [`session/update`](https://agentclientprotocol.com/protocol/v1/prompt-turn#3-agent-reports-output) notifications and update them as work progresses.

## Creating plans

When the language model creates an execution plan, the Agent **SHOULD** report it to the Client:

```json theme={null}
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123def456",
    "update": {
      "sessionUpdate": "plan",
      "entries": [
        {
          "content": "Analyze the existing codebase structure",
          "priority": "high",
          "status": "pending"
        },
        {
          "content": "Identify components that need refactoring",
          "priority": "high",
          "status": "pending"
        },
        {
          "content": "Create unit tests for critical functions",
          "priority": "medium",
          "status": "pending"
        }
      ]
    }
  }
}
```

**entries** `PlanEntry[]` *required*

An array of [plan entries](#plan-entries) representing the tasks to be
accomplished

## Plan entries

Each plan entry represents a specific task or goal within the overall execution strategy:

**content** `string` *required*

A human-readable description of what this task aims to accomplish

**priority** `PlanEntryPriority` *required*

The relative importance of this task.

* `high`
* `medium`
* `low`

**status** `PlanEntryStatus` *required*

The current execution status of this task

* `pending`
* `in_progress`
* `completed`

## Updating plans

As the Agent progresses through the plan, it **SHOULD** report updates by sending more `session/update` notifications with the same structure.

The Agent **MUST** send a complete list of all plan entries in each update and their current status. The Client **MUST** replace the current plan completely.

### Dynamic planning

Plans can change during execution. The Agent **MAY** add, remove, or modify plan entries as it discovers new requirements or completes tasks.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.