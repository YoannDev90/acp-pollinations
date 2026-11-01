> ## Documentation Index
> Fetch the complete documentation index at: https://agentclientprotocol.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Schema

> Schema definitions for the Agent Client Protocol

> [!NOTE]
>
> The schema file can be downloaded directly from the [latest GitHub
> release](https://github.com/agentclientprotocol/agent-client-protocol/releases/latest/download/schema.json).

## Agent

Defines the interface that all ACP-compliant agents must implement.

Agents are programs that use generative AI to autonomously modify code. They handle
requests from clients and execute tasks using language models and tools.

### authenticate

Authenticates the client using the specified authentication method.

Called when the agent requires authentication before allowing session creation.
The client provides an authentication method ID that was advertised during
initialization and whose type defines the `authenticate` flow.

After successful authentication, the client can proceed to create sessions with
`session/new` without receiving an `auth_required` (`-32000`) error.

See protocol docs: [Initialization](https://agentclientprotocol.com/protocol/v1/initialization.md)

#### AuthenticateRequest

Request parameters for the authenticate method.

Specifies which authentication method to use.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**methodId** `[AuthMethodId](#authmethodid)` *required*

The ID of the authentication method to use.
Must be one of the methods advertised in the initialize response.

#### AuthenticateResponse

Response to the `authenticate` method.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

### initialize

Establishes the connection with a client and negotiates protocol capabilities.

This method is called once at the beginning of the connection to:

* Negotiate the protocol version to use
* Exchange capability information between client and agent
* Determine available authentication methods

The agent should respond with its supported protocol version and capabilities.

See protocol docs: [Initialization](https://agentclientprotocol.com/protocol/v1/initialization.md)

#### InitializeRequest

Request parameters for the initialize method.

Sent by the client to establish connection and negotiate capabilities.

See protocol docs: [Initialization](https://agentclientprotocol.com/protocol/v1/initialization.md)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**clientCapabilities** `[ClientCapabilities](#clientcapabilities)`

Capabilities supported by the client.

* Default: `{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false,"auth":{"terminal":false}}`

**clientInfo** `[Implementation](#implementation) | null`

Information about the Client name and version sent to the Agent.

Note: in future versions of the protocol, this will be required.

**protocolVersion** `[ProtocolVersion](#protocolversion)` *required*

The latest protocol version supported by the client.

#### InitializeResponse

Response to the `initialize` method.

Contains the negotiated protocol version and agent capabilities.

See protocol docs: [Initialization](https://agentclientprotocol.com/protocol/v1/initialization.md)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**agentCapabilities** `[AgentCapabilities](#agentcapabilities)`

Capabilities supported by the agent.

* Default: `{"loadSession":false,"promptCapabilities":{"image":false,"audio":false,"embeddedContext":false},"mcpCapabilities":{"http":false,"sse":false},"sessionCapabilities":{},"auth":{}}`

**agentInfo** `[Implementation](#implementation) | null`

Information about the Agent name and version sent to the Client.

Note: in future versions of the protocol, this will be required.

**authMethods** `[AuthMethod\[\]](#authmethod)`

Authentication methods supported by the agent.

* Default: `[]`

**protocolVersion** `[ProtocolVersion](#protocolversion)` *required*

The protocol version the client specified if supported by the agent,
or the latest protocol version supported by the agent.

The client should disconnect, if it doesn't support this version.

### logout

Logs out of the current authenticated state.

After a successful logout, all new sessions will require authentication.
There is no guarantee about the behavior of already running sessions.

#### LogoutRequest

Request parameters for the logout method.

Terminates the current authenticated session.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

#### LogoutResponse

Response to the `logout` method.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

### session/cancel

Cancels ongoing operations for a session.

This is a notification sent by the client to cancel an ongoing prompt turn.

Upon receiving this notification, the Agent SHOULD:

* Stop all language model requests as soon as possible
* Abort all tool call invocations in progress
* Send any pending `session/update` notifications
* Respond to the original `session/prompt` request with the `cancelled` stop reason

See protocol docs: [Cancellation](https://agentclientprotocol.com/protocol/v1/prompt-turn.md#cancellation)

#### CancelNotification

Notification to cancel ongoing operations for a session.

See protocol docs: [Cancellation](https://agentclientprotocol.com/protocol/v1/prompt-turn.md#cancellation)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**sessionId** `[SessionId](#sessionid)` *required*

The ID of the session to cancel operations for.

### session/close

Closes an active session and frees up any resources associated with it.

This method is only available if the agent advertises the `sessionCapabilities.close` capability.

The agent must cancel any ongoing work (as if `session/cancel` was called)
and then free up any resources associated with the session.

#### CloseSessionRequest

Request parameters for closing an active session.

If supported, the agent **must** cancel any ongoing work related to the session
(treat it as if `session/cancel` was called) and then free up any resources
associated with the session.

Only available if the Agent supports the `sessionCapabilities.close` capability.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**sessionId** `[SessionId](#sessionid)` *required*

The ID of the session to close.

#### CloseSessionResponse

Response from closing a session.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

### session/delete

Deletes an existing session from `session/list`.

This method is only available if the agent advertises the `sessionCapabilities.delete` capability.

#### DeleteSessionRequest

Request parameters for deleting an existing session from `session/list`.

Only available if the Agent supports the `sessionCapabilities.delete` capability.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**sessionId** `[SessionId](#sessionid)` *required*

The ID of the session to delete.

#### DeleteSessionResponse

Response from deleting a session.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

### session/list

Lists existing sessions known to the agent.

This method is only available if the agent advertises the `sessionCapabilities.list` capability.

The agent should return metadata about sessions with optional filtering and pagination support.

#### ListSessionsRequest

Request parameters for listing existing sessions.

Only available if the Agent supports the `sessionCapabilities.list` capability.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**cursor** `string | null`

Opaque cursor token from a previous response's nextCursor field for cursor-based pagination

**cwd** `string | null`

Filter sessions by working directory. Must be an absolute path.

#### ListSessionsResponse

Response from listing sessions.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**nextCursor** `string | null`

Opaque cursor token. If present, pass this in the next request's cursor parameter
to fetch the next page. If absent, there are no more results.

**sessions** `[SessionInfo\[\]](#sessioninfo)` *required*

Array of session information objects

### session/load

Loads an existing session to resume a previous conversation.

This method is only available if the agent advertises the `loadSession` capability.

The agent should:

* Restore the session context and conversation history
* Connect to the specified MCP servers
* Stream the entire conversation history back to the client via notifications

See protocol docs: [Loading Sessions](https://agentclientprotocol.com/protocol/v1/session-setup.md#loading-sessions)

#### LoadSessionRequest

Request parameters for loading an existing session.

Only available if the Agent supports the `loadSession` capability.

See protocol docs: [Loading Sessions](https://agentclientprotocol.com/protocol/v1/session-setup.md#loading-sessions)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**additionalDirectories** `"string"[]`

Additional workspace roots to activate for this session. Each path must be absolute.

When omitted or empty, no additional roots are activated. When non-empty,
this is the complete resulting additional-root list for the loaded
session. It may differ from any previously used or reported list as long as
the request `cwd` matches the session's `cwd`.

**cwd** `string` *required*

The working directory for this session. Must be an absolute path.

**mcpServers** `[McpServer\[\]](#mcpserver)` *required*

List of MCP servers to connect to for this session.

**sessionId** `[SessionId](#sessionid)` *required*

The ID of the session to load.

#### LoadSessionResponse

Response from loading an existing session.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**configOptions** `[SessionConfigOption\[\]](#sessionconfigoption) | null`

Initial session configuration options if supported by the Agent.

**modes** `[SessionModeState](#sessionmodestate) | null`

Initial mode state if supported by the Agent

See protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/v1/session-modes.md)

### session/new

Creates a new conversation session with the agent.

Sessions represent independent conversation contexts with their own history and state.

The agent should:

* Create a new session context
* Connect to any specified MCP servers
* Return a unique session ID for future requests

May return an `auth_required` (`-32000`) error if the agent requires authentication.

See protocol docs: [Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup.md)

#### NewSessionRequest

Request parameters for creating a new session.

See protocol docs: [Creating a Session](https://agentclientprotocol.com/protocol/v1/session-setup.md#creating-a-session)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**additionalDirectories** `"string"[]`

Additional workspace roots for this session. Each path must be absolute.

These expand the session's filesystem scope without changing `cwd`, which
remains the base for relative paths. When omitted or empty, no
additional roots are activated for the new session.

**cwd** `string` *required*

The working directory for this session. Must be an absolute path.

**mcpServers** `[McpServer\[\]](#mcpserver)` *required*

List of MCP (Model Context Protocol) servers the agent should connect to.

#### NewSessionResponse

Response from creating a new session.

See protocol docs: [Creating a Session](https://agentclientprotocol.com/protocol/v1/session-setup.md#creating-a-session)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**configOptions** `[SessionConfigOption\[\]](#sessionconfigoption) | null`

Initial session configuration options if supported by the Agent.

**modes** `[SessionModeState](#sessionmodestate) | null`

Initial mode state if supported by the Agent

See protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/v1/session-modes.md)

**sessionId** `[SessionId](#sessionid)` *required*

Unique identifier for the created session.

Used in all subsequent requests for this conversation.

### session/prompt

Processes a user prompt within a session.

This method handles the whole lifecycle of a prompt:

* Receives user messages with optional context (files, images, etc.)
* Processes the prompt using language models
* Reports language model content and tool calls to the Clients
* Requests permission to run tools
* Executes any requested tool calls
* Returns when the turn is complete with a stop reason

See protocol docs: [Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn.md)

#### PromptRequest

Request parameters for sending a user prompt to the agent.

Contains the user's message and any additional context.

See protocol docs: [User Message](https://agentclientprotocol.com/protocol/v1/prompt-turn.md#1-user-message)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**prompt** `[ContentBlock\[\]](#contentblock)` *required*

The blocks of content that compose the user's message.

As a baseline, the Agent MUST support `text` and `resource_link` content blocks,
while other variants are optionally enabled via `PromptCapabilities`.

The Client MUST adapt its interface according to `PromptCapabilities`.

The client MAY include referenced pieces of context as either
`resource` or `resource_link` content blocks.

When available, `resource` is preferred
as it avoids extra round-trips and allows the message to include
pieces of context from sources the agent may not have access to.

**sessionId** `[SessionId](#sessionid)` *required*

The ID of the session to send this user message to

#### PromptResponse

Response from processing a user prompt.

See protocol docs: [Check for Completion](https://agentclientprotocol.com/protocol/v1/prompt-turn.md#4-check-for-completion)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**stopReason** `[StopReason](#stopreason)` *required*

Indicates why the agent stopped processing the turn.

### session/resume

Resumes an existing session without returning previous messages.

This method is only available if the agent advertises the `sessionCapabilities.resume` capability.

The agent should resume the session context, allowing the conversation to continue
without replaying the message history (unlike `session/load`).

#### ResumeSessionRequest

Request parameters for resuming an existing session.

Resumes an existing session without returning previous messages (unlike `session/load`).
This is useful for agents that can resume sessions but don't implement full session loading.

Only available if the Agent supports the `sessionCapabilities.resume` capability.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**additionalDirectories** `"string"[]`

Additional workspace roots to activate for this session. Each path must be absolute.

When omitted or empty, no additional roots are activated. When non-empty,
this is the complete resulting additional-root list for the resumed
session. It may differ from any previously used or reported list as long as
the request `cwd` matches the session's `cwd`.

**cwd** `string` *required*

The working directory for this session. Must be an absolute path.

**mcpServers** `[McpServer\[\]](#mcpserver)`

List of MCP servers to connect to for this session.

**sessionId** `[SessionId](#sessionid)` *required*

The ID of the session to resume.

#### ResumeSessionResponse

Response from resuming an existing session.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**configOptions** `[SessionConfigOption\[\]](#sessionconfigoption) | null`

Initial session configuration options if supported by the Agent.

**modes** `[SessionModeState](#sessionmodestate) | null`

Initial mode state if supported by the Agent

See protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/v1/session-modes.md)

### session/set\_config\_option

Sets the current value for a session configuration option.

#### SetSessionConfigOptionRequest

Request parameters for setting a session configuration option.

**Type:** Union

**Shared properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**configId** `[SessionConfigId](#sessionconfigid)` *required*

The ID of the configuration option to set.

**sessionId** `[SessionId](#sessionid)` *required*

The ID of the session to set the configuration option for.

**Variants:**

**boolean** `object`

A boolean value (`type: "boolean"`).

**Properties**

**type** `string` *required*

The discriminator value. Must be `"boolean"`.

**value** `boolean` *required*

The boolean value.

**value\_id** `object`

A `SessionConfigValueId` string value.

This is the default when `type` is absent on the wire. Unknown `type`
values with string payloads also gracefully deserialize into this
variant.

**Properties**

**value** `[SessionConfigValueId](#sessionconfigvalueid)` *required*

The value ID.

#### SetSessionConfigOptionResponse

Response to `session/set_config_option` method.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**configOptions** `[SessionConfigOption\[\]](#sessionconfigoption)` *required*

The full set of configuration options and their current values.

### session/set\_mode

Sets the current mode for a session.

Allows switching between different agent modes (e.g., "ask", "architect", "code")
that affect system prompts, tool availability, and permission behaviors.

The mode must be one of the modes advertised in `availableModes` during session
creation or loading. Agents may also change modes autonomously and notify the
client via `current_mode_update` notifications.

This method can be called at any time during a session, whether the Agent is
idle or actively generating a response.

See protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/v1/session-modes.md)

#### SetSessionModeRequest

Request parameters for setting a session mode.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**modeId** `[SessionModeId](#sessionmodeid)` *required*

The ID of the mode to set.

**sessionId** `[SessionId](#sessionid)` *required*

The ID of the session to set the mode for.

#### SetSessionModeResponse

Response to `session/set_mode` method.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

## Client

Defines the interface that ACP-compliant clients must implement.

Clients are typically code editors (IDEs, text editors) that provide the interface
between users and AI agents. They manage the environment, handle user interactions,
and control access to resources.

### elicitation/complete

Notification that a URL-based elicitation has completed.

See protocol docs: [Elicitation](https://agentclientprotocol.com/protocol/v1/elicitation.md#url-completion)

#### CompleteElicitationNotification

Notification sent by the agent when a URL-based elicitation is complete.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

Optional. Omitted and `null` are equivalent and mean no metadata.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**elicitationId** `[ElicitationId](#elicitationid)` *required*

The ID of the elicitation that completed.

### elicitation/create

Requests structured user input via a form or URL.

See protocol docs: [Elicitation](https://agentclientprotocol.com/protocol/v1/elicitation.md)

#### CreateElicitationRequest

Request from the agent to elicit structured user input.

The agent sends this to the client to request information from the user,
either via a form or by directing them to a URL.
Elicitations are tied to a session (optionally a tool call) or a request.

**Type:** Union

**Shared properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

Optional. Omitted and `null` are equivalent and mean no metadata.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**message** `string` *required*

A human-readable message describing what input is needed.

**Variants:**

**form** `object`

Form-based elicitation where the client renders a form from the provided schema.

**Properties**

**mode** `string` *required*

The discriminator value. Must be `"form"`.

**requestedSchema** `[ElicitationSchema](#elicitationschema)` *required*

A JSON Schema describing the form fields to present to the user.

**Alternatives (`anyOf`):**

**Session**

Tied to a session, optionally to a specific tool call within that session.

**Properties**

**sessionId** `[SessionId](#sessionid)` *required*

The session this elicitation is tied to.

**toolCallId** `[ToolCallId](#toolcallid) | null`

Optional tool call within the session.

Optional. Omitted and `null` are equivalent and mean the elicitation is scoped to the
session without a specific tool call.

**Request**

Tied to a specific JSON-RPC request outside of a session
(e.g., during auth/configuration phases before any session is started).

**Properties**

**requestId** `[RequestId](#requestid)` *required*

The request this elicitation is tied to.

**url** `object`

URL-based elicitation where the client directs the user to a URL.

**Properties**

**elicitationId** `[ElicitationId](#elicitationid)` *required*

The unique identifier for this elicitation.

**mode** `string` *required*

The discriminator value. Must be `"url"`.

**url** `string` *required*

The URL to direct the user to.

* Format: `uri`

**Alternatives (`anyOf`):**

**Session**

Tied to a session, optionally to a specific tool call within that session.

**Properties**

**sessionId** `[SessionId](#sessionid)` *required*

The session this elicitation is tied to.

**toolCallId** `[ToolCallId](#toolcallid) | null`

Optional tool call within the session.

Optional. Omitted and `null` are equivalent and mean the elicitation is scoped to the
session without a specific tool call.

**Request**

Tied to a specific JSON-RPC request outside of a session
(e.g., during auth/configuration phases before any session is started).

**Properties**

**requestId** `[RequestId](#requestid)` *required*

The request this elicitation is tied to.

**other** `object`

Custom or future elicitation mode.

Values beginning with `_` are reserved for implementation-specific
extensions. Unknown values that do not begin with `_` are reserved for
future ACP variants.

Clients that do not understand this mode should preserve the raw payload
when storing, replaying, proxying, or forwarding elicitation requests.
They MUST NOT render it as a known elicitation mode.

**Properties**

**mode** `string` *required*

Custom or future elicitation mode.

Values beginning with `_` are reserved for implementation-specific
extensions. Unknown values that do not begin with `_` are reserved for
future ACP variants.

**Alternatives (`anyOf`):**

**Session**

Tied to a session, optionally to a specific tool call within that session.

**Properties**

**sessionId** `[SessionId](#sessionid)` *required*

The session this elicitation is tied to.

**toolCallId** `[ToolCallId](#toolcallid) | null`

Optional tool call within the session.

Optional. Omitted and `null` are equivalent and mean the elicitation is scoped to the
session without a specific tool call.

**Request**

Tied to a specific JSON-RPC request outside of a session
(e.g., during auth/configuration phases before any session is started).

**Properties**

**requestId** `[RequestId](#requestid)` *required*

The request this elicitation is tied to.

#### CreateElicitationResponse

Response from the client to an elicitation request.

**Type:** Union

**Shared properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

Optional. Omitted and `null` are equivalent and mean no metadata.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**Variants:**

**accept** `object`

The user accepted and provided content.

**Properties**

**action** `string` *required*

The discriminator value. Must be `"accept"`.

**content** `object | null`

The user-provided content, if any, as an object matching the requested schema.

**decline** `object`

The user declined the elicitation.

**Properties**

**action** `string` *required*

The discriminator value. Must be `"decline"`.

**cancel** `object`

The elicitation was cancelled.

**Properties**

**action** `string` *required*

The discriminator value. Must be `"cancel"`.

**other** `object`

Custom or future elicitation action.

Values beginning with `_` are reserved for implementation-specific
extensions. Unknown values that do not begin with `_` are reserved for
future ACP variants.

Agents that do not understand this action should preserve the raw
payload when storing, replaying, proxying, or forwarding elicitation
responses. They MUST NOT treat it as a known elicitation action.

**Properties**

**action** `string` *required*

Custom or future elicitation action.

Values beginning with `_` are reserved for implementation-specific
extensions. Unknown values that do not begin with `_` are reserved for
future ACP variants.

### fs/read\_text\_file

Reads content from a text file in the client's file system.

Only available if the client advertises the `fs.readTextFile` capability.
Allows the agent to access file contents within the client's environment.

See protocol docs: [Client](https://agentclientprotocol.com/protocol/v1/overview.md#client)

#### ReadTextFileRequest

Request to read content from a text file.

Only available if the client supports the `fs.readTextFile` capability.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**limit** `integer | null`

Maximum number of lines to read.

* Minimum: `0`

**line** `integer | null`

Line number to start reading from (1-based).

* Minimum: `0`

**path** `string` *required*

Absolute path to the file to read.

**sessionId** `[SessionId](#sessionid)` *required*

The session ID for this request.

#### ReadTextFileResponse

Response containing the contents of a text file.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**content** `string` *required*

Content payload returned by this response.

### fs/write\_text\_file

Writes content to a text file in the client's file system.

Only available if the client advertises the `fs.writeTextFile` capability.
Allows the agent to create or modify files within the client's environment.

See protocol docs: [Client](https://agentclientprotocol.com/protocol/v1/overview.md#client)

#### WriteTextFileRequest

Request to write content to a text file.

Only available if the client supports the `fs.writeTextFile` capability.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**content** `string` *required*

The text content to write to the file.

**path** `string` *required*

Absolute path to the file to write.

**sessionId** `[SessionId](#sessionid)` *required*

The session ID for this request.

#### WriteTextFileResponse

Response to `fs/write_text_file`

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

### session/request\_permission

Requests permission from the user for a tool call operation.

Called by the agent when it needs user authorization before executing
a potentially sensitive operation. The client should present the options
to the user and return their decision.

If the client cancels the prompt turn via `session/cancel`, it MUST
respond to this request with the `cancelled` outcome.

See protocol docs: [Requesting Permission](https://agentclientprotocol.com/protocol/v1/tool-calls.md#requesting-permission)

#### RequestPermissionRequest

Request for user permission to execute a tool call.

Sent when the agent needs authorization before performing a sensitive operation.

See protocol docs: [Requesting Permission](https://agentclientprotocol.com/protocol/v1/tool-calls.md#requesting-permission)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**options** `[PermissionOption\[\]](#permissionoption)` *required*

Available permission options for the user to choose from.

**sessionId** `[SessionId](#sessionid)` *required*

The session ID for this request.

**toolCall** `[ToolCallUpdate](#toolcallupdate)` *required*

Details about the tool call requiring permission.

#### RequestPermissionResponse

Response to a permission request.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**outcome** `[RequestPermissionOutcome](#requestpermissionoutcome)` *required*

The user's decision on the permission request.

### session/update

Handles session update notifications from the agent.

This is a notification endpoint (no response expected) that receives
real-time updates about session progress, including message chunks,
tool calls, and execution plans.

Note: Clients SHOULD continue accepting tool call updates even after
sending a `session/cancel` notification, as the agent may send final
updates before responding with the cancelled stop reason.

See protocol docs: [Agent Reports Output](https://agentclientprotocol.com/protocol/v1/prompt-turn.md#3-agent-reports-output)

#### SessionNotification

Notification containing a session update from the agent.

Used to stream real-time progress and results during prompt processing.

See protocol docs: [Agent Reports Output](https://agentclientprotocol.com/protocol/v1/prompt-turn.md#3-agent-reports-output)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**sessionId** `[SessionId](#sessionid)` *required*

The ID of the session this update pertains to.

**update** `[SessionUpdate](#sessionupdate)` *required*

The actual update content.

### terminal/create

Executes a command in a new terminal

Only available if the `terminal` Client capability is set to `true`.

Returns a `TerminalId` that can be used with other terminal methods
to get the current output, wait for exit, and kill the command.

The `TerminalId` can also be used to embed the terminal in a tool call
by using `terminal` tool call content.

The Agent is responsible for releasing the terminal by using the `terminal/release`
method.

See protocol docs: [Terminals](https://agentclientprotocol.com/protocol/v1/terminals.md)

#### CreateTerminalRequest

Request to create a new terminal and execute a command.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**args** `"string"[]`

Array of command arguments.

**command** `string` *required*

The command to execute.

**cwd** `string | null`

Working directory for the command. Must be an absolute path.

**env** `[EnvVariable\[\]](#envvariable)`

Environment variables for the command.

**outputByteLimit** `integer | null`

Maximum number of output bytes to retain.

When the limit is exceeded, the Client truncates from the beginning of the output
to stay within the limit.

The Client MUST ensure truncation happens at a character boundary to maintain valid
string output, even if this means the retained output is slightly less than the
specified limit.

* Minimum: `0`

**sessionId** `[SessionId](#sessionid)` *required*

The session ID for this request.

#### CreateTerminalResponse

Response containing the ID of the created terminal.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**terminalId** `[TerminalId](#terminalid)` *required*

The unique identifier for the created terminal.

### terminal/kill

Kills the terminal command without releasing the terminal

While `terminal/release` will also kill the command, this method will keep
the `TerminalId` valid so it can be used with other methods.

This method can be helpful when implementing command timeouts which terminate
the command as soon as elapsed, and then get the final output so it can be sent
to the model.

Note: Call `terminal/release` when `TerminalId` is no longer needed.

See protocol docs: [Terminals](https://agentclientprotocol.com/protocol/v1/terminals.md)

#### KillTerminalRequest

Request to kill a terminal without releasing it.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**sessionId** `[SessionId](#sessionid)` *required*

The session ID for this request.

**terminalId** `[TerminalId](#terminalid)` *required*

The ID of the terminal to kill.

#### KillTerminalResponse

Response to `terminal/kill` method

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

### terminal/output

Gets the terminal output and exit status

Returns the current content in the terminal without waiting for the command to exit.
If the command has already exited, the exit status is included.

See protocol docs: [Terminals](https://agentclientprotocol.com/protocol/v1/terminals.md)

#### TerminalOutputRequest

Request to get the current output and status of a terminal.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**sessionId** `[SessionId](#sessionid)` *required*

The session ID for this request.

**terminalId** `[TerminalId](#terminalid)` *required*

The ID of the terminal to get output from.

#### TerminalOutputResponse

Response containing the terminal output and exit status.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**exitStatus** `[TerminalExitStatus](#terminalexitstatus) | null`

Exit status if the command has completed.

**output** `string` *required*

The terminal output captured so far.

**truncated** `boolean` *required*

Whether the output was truncated due to byte limits.

### terminal/release

Releases a terminal

The command is killed if it hasn't exited yet. Use `terminal/wait_for_exit`
to wait for the command to exit before releasing the terminal.

After release, the `TerminalId` can no longer be used with other `terminal/*` methods,
but tool calls that already contain it, continue to display its output.

The `terminal/kill` method can be used to terminate the command without releasing
the terminal, allowing the Agent to call `terminal/output` and other methods.

See protocol docs: [Terminals](https://agentclientprotocol.com/protocol/v1/terminals.md)

#### ReleaseTerminalRequest

Request to release a terminal and free its resources.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**sessionId** `[SessionId](#sessionid)` *required*

The session ID for this request.

**terminalId** `[TerminalId](#terminalid)` *required*

The ID of the terminal to release.

#### ReleaseTerminalResponse

Response to terminal/release method

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

### terminal/wait\_for\_exit

Waits for the terminal command to exit and return its exit status

See protocol docs: [Terminals](https://agentclientprotocol.com/protocol/v1/terminals.md)

#### WaitForTerminalExitRequest

Request to wait for a terminal command to exit.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**sessionId** `[SessionId](#sessionid)` *required*

The session ID for this request.

**terminalId** `[TerminalId](#terminalid)` *required*

The ID of the terminal to wait for.

#### WaitForTerminalExitResponse

Response containing the exit status of a terminal command.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**exitCode** `integer | null`

The process exit code (may be null if terminated by signal).

* Minimum: `0`

**signal** `string | null`

The signal that terminated the process (may be null if exited normally).

## Protocol Level

Defines the interface that ACP-compliant agents and clients must both implement.

Notifications whose methods start with '$/' are messages which are protocol
implementation dependent and might not be implementable in all clients or
agents. For example if the implementation uses a single threaded synchronous
programming language then there is little it can do to react to a `$/cancel\_request\` notification. If an agent or client receives notifications
starting with '\$/' it is free to ignore the notification.

### \$/cancel\_request

Cancels an ongoing request.

This is a notification sent by the side that sent a request to cancel that request.

Upon receiving this notification, the receiver:

1. MAY cancel the corresponding request activity and all nested activities
2. MAY send any pending notifications.
3. MUST send one of these responses for the original request:

* Valid response with appropriate data (partial results or cancellation marker)
* Error response with code `-32800` (Cancelled)

See protocol docs: [Cancellation](https://agentclientprotocol.com/protocol/v1/cancellation.md)

#### CancelRequestNotification

Notification to cancel an ongoing request.

See protocol docs: [Cancellation](https://agentclientprotocol.com/protocol/v1/cancellation.md)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**requestId** `[RequestId](#requestid)` *required*

The ID of the request to cancel.

## AgentAuthCapabilities

Authentication-related capabilities supported by the agent.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**logout** `[LogoutCapabilities](#logoutcapabilities) | null`

Whether the agent supports the logout method.

Optional. Omitted or `null` both mean the agent does not advertise support.
Supplying `\{\}` means the agent supports the logout method.

## AgentCapabilities

Capabilities supported by the agent.

Advertised during initialization to inform the client about
available features and content types.

See protocol docs: [Agent Capabilities](https://agentclientprotocol.com/protocol/v1/initialization.md#agent-capabilities)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**auth** `[AgentAuthCapabilities](#agentauthcapabilities)`

Authentication-related capabilities supported by the agent.

* Default: `{}`

**loadSession** `boolean`

Whether the agent supports `session/load`.

* Default: `false`

**mcpCapabilities** `[McpCapabilities](#mcpcapabilities)`

MCP capabilities supported by the agent.

* Default: `{"http":false,"sse":false}`

**promptCapabilities** `[PromptCapabilities](#promptcapabilities)`

Prompt capabilities supported by the agent.

* Default: `{"image":false,"audio":false,"embeddedContext":false}`

**sessionCapabilities** `[SessionCapabilities](#sessioncapabilities)`

Session lifecycle and prompt capabilities advertised by the agent.

* Default: `{}`

## Annotations

Optional annotations for the client. The client can use annotations to inform how objects are used or displayed

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**audience** `[Role\[\]](#role) | null`

Intended recipients for this content, such as the user or assistant.

**lastModified** `string | null`

Timestamp indicating when the underlying resource was last modified.

**priority** `number | null`

Relative importance of this content when clients choose what to surface.

## AudioContent

Audio provided to or from an LLM.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**annotations** `[Annotations](#annotations) | null`

Optional annotations that help clients decide how to display or route this content.

**data** `string` *required*

Base64-encoded media payload.

**mimeType** `string` *required*

MIME type describing the encoded media payload.

## AuthCapabilities

Authentication capabilities supported by the client.

Advertised during initialization to inform the agent which authentication
method types the client can handle. This governs opt-in types that require
additional client-side support.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**terminal** `boolean`

Whether the client supports `terminal` authentication methods.

The client should set this to `true` only when it can reproduce the
configured agent invocation in an interactive terminal. When `true`, the
agent may include `terminal` entries in its authentication methods.

* Default: `false`

## AuthMethod

Describes an available authentication method.

The `type` field acts as the discriminator in the serialized JSON form.
When no `type` is present, the method is treated as `agent`.

**Type:** Union

**terminal** `object`

Client runs the configured agent program as a separate interactive
process, without passing this method to `authenticate`.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**args** `"string"[]`

Additional arguments to append to the configured agent invocation for terminal auth.

**description** `string | null`

Optional human-readable description of this authentication method.

**env** `object`

Additional environment variables to set on the configured agent invocation for terminal auth.
These values override same-named variables in the base launch configuration.

**id** `[AuthMethodId](#authmethodid)` *required*

Unique identifier for this authentication method.

**name** `string` *required*

Human-readable name of the authentication method.

**type** `string` *required*

The discriminator value. Must be `"terminal"`.

**agent**

Agent handles authentication itself through `authenticate`.

This is the default when no `type` is specified.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**description** `string | null`

Optional human-readable description of this authentication method.

**id** `[AuthMethodId](#authmethodid)` *required*

Unique identifier for this authentication method.

**name** `string` *required*

Human-readable name of the authentication method.

## AuthMethodAgent

Agent handles authentication itself through `authenticate`.

This is the default authentication method type.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**description** `string | null`

Optional human-readable description of this authentication method.

**id** `[AuthMethodId](#authmethodid)` *required*

Unique identifier for this authentication method.

**name** `string` *required*

Human-readable name of the authentication method.

## AuthMethodId

Typed identifier used for auth method values on the wire.

**Type:** `string`

## AuthMethodTerminal

Terminal-based authentication method.

The client runs the configured agent program as a separate interactive
process for the user to authenticate via a TUI. Agents MUST advertise this
method only when the client enabled its terminal authentication capability.
A zero exit status signals success. Any other termination signals failure.
The client MUST NOT pass this method to `authenticate`.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**args** `"string"[]`

Additional arguments to append to the configured agent invocation for terminal auth.

**description** `string | null`

Optional human-readable description of this authentication method.

**env** `object`

Additional environment variables to set on the configured agent invocation for terminal auth.
These values override same-named variables in the base launch configuration.

**id** `[AuthMethodId](#authmethodid)` *required*

Unique identifier for this authentication method.

**name** `string` *required*

Human-readable name of the authentication method.

## AvailableCommand

Information about a command.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**description** `string` *required*

Human-readable description of what the command does.

**input** `[AvailableCommandInput](#availablecommandinput) | null`

Input for the command if required

**name** `string` *required*

Command name (e.g., `create_plan`, `research_codebase`).

## AvailableCommandInput

The input specification for a command.

All text that was typed after the command name is provided as input.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**hint** `string` *required*

A hint to display when the input hasn't been provided yet

## AvailableCommandsUpdate

Available commands are ready or have changed

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**availableCommands** `[AvailableCommand\[\]](#availablecommand)` *required*

Commands the agent can execute

## BlobResourceContents

Binary resource contents.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**blob** `string` *required*

Base64-encoded bytes for a binary resource payload.

**mimeType** `string | null`

MIME type describing the encoded media payload.

**uri** `string` *required*

URI associated with this resource or media payload.

## BooleanConfigOptionCapabilities

Capabilities for boolean session configuration options.

Supplying `\{\}` means the client supports boolean session configuration options.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

## BooleanPropertySchema

Schema for boolean properties in an elicitation form.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

Optional. Omitted and `null` are equivalent and mean no metadata.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**default** `boolean | null`

Default value.

Optional. Omitted and `null` are equivalent and mean no default value is provided.

**description** `string | null`

Human-readable description.

Optional. Omitted and `null` are equivalent and mean no description is provided.

**title** `string | null`

Optional title for the property.

Optional. Omitted and `null` are equivalent and mean no title is provided.

## ClientCapabilities

Capabilities supported by the client.

Advertised during initialization to inform the agent about
available features and methods.

See protocol docs: [Client Capabilities](https://agentclientprotocol.com/protocol/v1/initialization.md#client-capabilities)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**auth** `[AuthCapabilities](#authcapabilities)`

Authentication capabilities supported by the client.
Determines which authentication method types the agent may include
in its `InitializeResponse`.

* Default: `{"terminal":false}`

**elicitation** `[ElicitationCapabilities](#elicitationcapabilities) | null`

Elicitation capabilities supported by the client.
Determines which elicitation modes the agent may use.

Optional. Omitted or `null` both mean the client does not advertise
elicitation support.

**fs** `[FileSystemCapabilities](#filesystemcapabilities)`

File system capabilities supported by the client.
Determines which file operations the agent can request.

* Default: `{"readTextFile":false,"writeTextFile":false}`

**session** `[ClientSessionCapabilities](#clientsessioncapabilities) | null`

Session-related capabilities supported by the client.

Optional. Omitted or `null` both mean the client does not advertise any
session-related extensions.

**terminal** `boolean`

Whether the Client support all `terminal/*` methods.

* Default: `false`

## ClientSessionCapabilities

Session-related capabilities supported by the client.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**compaction** `[CompactionCapabilities](#compactioncapabilities) | null`

Support for ID-addressed context compaction updates. Omitted or `null`
means unsupported. `\{\}` advertises the complete compaction contract.

**configOptions** `[SessionConfigOptionsCapabilities](#sessionconfigoptionscapabilities) | null`

Config option capabilities supported by the client.

Omitted or `null` both mean the client does not advertise support for any
config option extensions.

**notices** `[NoticeCapabilities](#noticecapabilities) | null`

Support for live user-facing `notice` session updates.

Optional. Omitted or `null` both mean the client does not advertise support.
Supplying `\{\}` means the client can present notices to the user.

## CompactionCapabilities

Client support for ID-addressed context compaction updates.

**Type:** `object`

## CompactionId

Unique identifier for a context compaction within a session.

**Type:** `string`

## CompactionStatus

Lifecycle state of a context compaction.

**Type:** Union

**in\_progress** `string`

Compaction has started and has not finished.

**completed** `string`

Compaction finished successfully.

**failed** `string`

Compaction finished unsuccessfully.

**cancelled** `string`

Compaction was cancelled before it finished.

**other** `string`

Custom or future compaction status.

Values beginning with `_` are reserved for implementation-specific
extensions. Other unknown values are reserved for future ACP statuses.

## CompactionSummaryChunk

A content block appended to a compaction's summary. A first-seen ID creates
an in-progress compaction. Chunks append in receive order.
Agents MUST only send this update when the Client advertised
the `session.compaction` Client capability.

**Type:** Object

**Properties:**

**\_meta** `object | null`

Metadata scoped to this chunk. Omission and `null` both mean absent.

**compactionId** `[CompactionId](#compactionid)` *required*

ID of the compaction whose summary receives this content.

**content** `[ContentBlock](#contentblock)` *required*

One content block to append.

## CompactionUpdate

A context compaction upsert. The first notification fixes the compaction's
timeline position. Later updates with the same ID patch that entity in place.
Agents MUST only send this update when the Client advertised
the `session.compaction` Client capability.

`summary`, `error`, and `_meta` have patch semantics: omission leaves the
stored value unchanged, `null` clears it, and a concrete value replaces it.
`summary: []` also clears the summary.

**Type:** Object

**Properties:**

**\_meta** `object | null`

Extensible metadata patch for this compaction.

**compactionId** `[CompactionId](#compactionid)` *required*

The Agent-owned ID of this compaction, unique within the session.

**error** `string | null`

Human-readable error details for the compaction.

**status** `[CompactionStatus](#compactionstatus)` *required*

Current lifecycle status.

**summary** \`[ContentBlock\[\]](#contentblock)

\| null\`

Complete replacement user-displayable summary content for the compaction.

## ConfigOptionUpdate

Session configuration options have been updated.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**configOptions** `[SessionConfigOption\[\]](#sessionconfigoption)` *required*

The full set of configuration options and their current values.

## Content

Standard content block (text, images, resources).

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**content** `[ContentBlock](#contentblock)` *required*

The actual content block.

## ContentBlock

Content blocks represent displayable information in the Agent Client Protocol.

Content blocks appear in:

* User prompts sent via `session/prompt`
* Language model output streamed through `session/update` notifications
* Progress updates and results from tool calls

This structure is compatible with the Model Context Protocol (MCP), so agents can
forward content from MCP tool outputs without transformation.

See protocol docs: [Content](https://agentclientprotocol.com/protocol/v1/content.md)

**Type:** Union

**text** `object`

Text content. May be plain text or formatted with Markdown.

All agents MUST support text content blocks in prompts.
Clients SHOULD render this text as Markdown.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**annotations** `[Annotations](#annotations) | null`

Optional annotations that help clients decide how to display or route this content.

**text** `string` *required*

Text payload carried by this content block.

**type** `string` *required*

The discriminator value. Must be `"text"`.

**image** `object`

Images for visual context or analysis.

Requires the `image` prompt capability when included in prompts.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**annotations** `[Annotations](#annotations) | null`

Optional annotations that help clients decide how to display or route this content.

**data** `string` *required*

Base64-encoded media payload.

**mimeType** `string` *required*

MIME type describing the encoded media payload.

**type** `string` *required*

The discriminator value. Must be `"image"`.

**uri** `string | null`

URI associated with this resource or media payload.

**audio** `object`

Audio data for transcription or analysis.

Requires the `audio` prompt capability when included in prompts.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**annotations** `[Annotations](#annotations) | null`

Optional annotations that help clients decide how to display or route this content.

**data** `string` *required*

Base64-encoded media payload.

**mimeType** `string` *required*

MIME type describing the encoded media payload.

**type** `string` *required*

The discriminator value. Must be `"audio"`.

**resource\_link** `object`

References to resources that the agent can access.

All agents MUST support resource links in prompts.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**annotations** `[Annotations](#annotations) | null`

Optional annotations that help clients decide how to display or route this content.

**description** `string | null`

Optional human-readable details shown with this protocol object.

**mimeType** `string | null`

MIME type describing the encoded media payload.

**name** `string` *required*

Human-readable name shown for this protocol object.

**size** `integer | null`

Optional size of the linked resource in bytes, if known.

**title** `string | null`

Optional display title for end-user UI.

**type** `string` *required*

The discriminator value. Must be `"resource_link"`.

**uri** `string` *required*

URI associated with this resource or media payload.

**resource** `object`

Complete resource contents embedded directly in the message.

Preferred for including context as it avoids extra round-trips.

Requires the `embeddedContext` prompt capability when included in prompts.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**annotations** `[Annotations](#annotations) | null`

Optional annotations that help clients decide how to display or route this content.

**resource** `[EmbeddedResourceResource](#embeddedresourceresource)` *required*

Embedded resource payload, either text or binary data.

**type** `string` *required*

The discriminator value. Must be `"resource"`.

## ContentChunk

A streamed item of content

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**content** `[ContentBlock](#contentblock)` *required*

A single item of content

**messageId** `[MessageId](#messageid) | null`

A unique identifier for the message this chunk belongs to.

All chunks belonging to the same message share the same `messageId`.
A change in `messageId` indicates a new message has started.

## Cost

Cost information for a session.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**amount** `number` *required*

Total cumulative cost for session.

**currency** `string` *required*

Unit of `amount`: an ISO 4217 currency code (e.g., "USD", "EUR") for money, or another
unit such as "credits".

## CurrentModeUpdate

The current mode of the session has changed

See protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/v1/session-modes.md)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**currentModeId** `[SessionModeId](#sessionmodeid)` *required*

The ID of the current mode

## Diff

A diff representing file modifications.

Shows changes to files in a format suitable for display in the client UI.

See protocol docs: [Content](https://agentclientprotocol.com/protocol/v1/tool-calls.md#content)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**newText** `string` *required*

The new content after modification.

**oldText** `string | null`

The original content (omitted or `null` for new files).

**path** `string` *required*

The absolute file path being modified.

## ElicitationAcceptAction

The user accepted the elicitation and provided content.

**Type:** Object

**Properties:**

**content** `object | null`

The user-provided content, if any, as an object matching the requested schema.

## ElicitationCapabilities

Elicitation capabilities supported by the client.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

Optional. Omitted and `null` are equivalent and mean no metadata.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**form** `[ElicitationFormCapabilities](#elicitationformcapabilities) | null`

Whether the client supports form-based elicitation.

Optional. Omitted and `null` are equivalent and mean form support is not advertised.
Supplying `\{\}` explicitly advertises form support.

**url** `[ElicitationUrlCapabilities](#elicitationurlcapabilities) | null`

Whether the client supports URL-based elicitation.

Optional. Omitted or `null` both mean the client does not advertise support.
Supplying `\{\}` means the client supports URL-based elicitation.

## ElicitationContentValue

Allowed wire representations for `ElicitationContentValue`.

**Type:** Union

**String** `string`

String value accepted in elicitation response content.

**Integer** `int64`

Integer value accepted in elicitation response content.

**Number** `double`

Number value accepted in elicitation response content.

**Boolean** `boolean`

Boolean value accepted in elicitation response content.

**StringArray** `array`

String array value accepted in elicitation response content.

## ElicitationFormCapabilities

Form-based elicitation capabilities.

Supplying `\{\}` means the client supports form-based elicitation.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

Optional. Omitted and `null` are equivalent and mean no metadata.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

## ElicitationFormMode

Form-based elicitation mode where the client renders a form from the provided schema.

**Type:** Union

**Shared properties:**

**requestedSchema** `[ElicitationSchema](#elicitationschema)` *required*

A JSON Schema describing the form fields to present to the user.

**Variants:**

**Session**

Tied to a session, optionally to a specific tool call within that session.

**Properties**

**sessionId** `[SessionId](#sessionid)` *required*

The session this elicitation is tied to.

**toolCallId** `[ToolCallId](#toolcallid) | null`

Optional tool call within the session.

Optional. Omitted and `null` are equivalent and mean the elicitation is scoped to the
session without a specific tool call.

**Request**

Tied to a specific JSON-RPC request outside of a session
(e.g., during auth/configuration phases before any session is started).

**Properties**

**requestId** `[RequestId](#requestid)` *required*

The request this elicitation is tied to.

## ElicitationId

Unique identifier for an elicitation.

**Type:** `string`

## ElicitationPropertySchema

Property schema for elicitation form fields.

Each variant corresponds to a JSON Schema `"type"` value.
Single-select enums use `type: "string"` with `enum` or `oneOf` set.
Multi-select enums use `type: "array"`.

**Type:** Union

**string** `object`

String property (or single-select enum when `enum`/`oneOf` is set).

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

Optional. Omitted and `null` are equivalent and mean no metadata.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**default** `string | null`

Default value.

Optional. Omitted and `null` are equivalent and mean no default value is provided.

**description** `string | null`

Human-readable description.

Optional. Omitted and `null` are equivalent and mean no description is provided.

**enum** `"string"[] | null`

Enum values for untitled single-select enums.
Optional. Omitted and `null` are equivalent and mean no untitled single-select choices are
declared by `enum`.

**format** `[StringFormat](#stringformat) | null`

String format.

Optional. Omitted and `null` are equivalent and mean there is no format constraint.

**maxLength** `integer | null`

Maximum string length.

Optional. Omitted and `null` are equivalent and mean there is no maximum length constraint.

* Minimum: `0`

**minLength** `integer | null`

Minimum string length.

Optional. Omitted and `null` are equivalent and mean there is no minimum length constraint.

* Minimum: `0`

**oneOf** `[EnumOption\[\]](#enumoption) | null`

Titled enum options for titled single-select enums.
Optional. Omitted and `null` are equivalent and mean no titled single-select choices are
declared by `oneOf`.

**pattern** `string | null`

Pattern the string must match.

Optional. Omitted and `null` are equivalent and mean there is no pattern constraint.

**title** `string | null`

Optional title for the property.

Optional. Omitted and `null` are equivalent and mean no title is provided.

**type** `string` *required*

The discriminator value. Must be `"string"`.

**number** `object`

Number (floating-point) property.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

Optional. Omitted and `null` are equivalent and mean no metadata.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**default** `number | null`

Default value.

Optional. Omitted and `null` are equivalent and mean no default value is provided.

**description** `string | null`

Human-readable description.

Optional. Omitted and `null` are equivalent and mean no description is provided.

**maximum** `number | null`

Maximum value (inclusive).

Optional. Omitted and `null` are equivalent and mean there is no inclusive upper bound.

**minimum** `number | null`

Minimum value (inclusive).

Optional. Omitted and `null` are equivalent and mean there is no inclusive lower bound.

**title** `string | null`

Optional title for the property.

Optional. Omitted and `null` are equivalent and mean no title is provided.

**type** `string` *required*

The discriminator value. Must be `"number"`.

**integer** `object`

Integer property.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

Optional. Omitted and `null` are equivalent and mean no metadata.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**default** `integer | null`

Default value.

Optional. Omitted and `null` are equivalent and mean no default value is provided.

**description** `string | null`

Human-readable description.

Optional. Omitted and `null` are equivalent and mean no description is provided.

**maximum** `integer | null`

Maximum value (inclusive).

Optional. Omitted and `null` are equivalent and mean there is no inclusive upper bound.

**minimum** `integer | null`

Minimum value (inclusive).

Optional. Omitted and `null` are equivalent and mean there is no inclusive lower bound.

**title** `string | null`

Optional title for the property.

Optional. Omitted and `null` are equivalent and mean no title is provided.

**type** `string` *required*

The discriminator value. Must be `"integer"`.

**boolean** `object`

Boolean property.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

Optional. Omitted and `null` are equivalent and mean no metadata.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**default** `boolean | null`

Default value.

Optional. Omitted and `null` are equivalent and mean no default value is provided.

**description** `string | null`

Human-readable description.

Optional. Omitted and `null` are equivalent and mean no description is provided.

**title** `string | null`

Optional title for the property.

Optional. Omitted and `null` are equivalent and mean no title is provided.

**type** `string` *required*

The discriminator value. Must be `"boolean"`.

**array** `object`

Multi-select array property.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

Optional. Omitted and `null` are equivalent and mean no metadata.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**default** `"string"[] | null`

Default selected values.

Optional. Omitted and `null` are equivalent and mean no default selections are provided.

**description** `string | null`

Human-readable description.

Optional. Omitted and `null` are equivalent and mean no description is provided.

**items** `[MultiSelectItems](#multiselectitems)` *required*

The items definition describing allowed values.

**maxItems** `integer | null`

Maximum number of items to select.

Optional. Omitted and `null` are equivalent and mean there is no maximum selection count.

* Minimum: `0`

**minItems** `integer | null`

Minimum number of items to select.

Optional. Omitted and `null` are equivalent and mean there is no minimum selection count.

* Minimum: `0`

**title** `string | null`

Optional title for the property.

Optional. Omitted and `null` are equivalent and mean no title is provided.

**type** `string` *required*

The discriminator value. Must be `"array"`.

**other** `object`

Custom or future elicitation property schema.

Values beginning with `_` are reserved for implementation-specific
extensions. Unknown values that do not begin with `_` are reserved for
future ACP variants.

Clients that do not understand this property schema type should preserve
the raw schema when storing, replaying, proxying, or forwarding
elicitation requests. They MUST NOT render it as a known input control.

**Properties**

**type** `string` *required*

Custom or future elicitation property schema type.

Values beginning with `_` are reserved for implementation-specific
extensions. Unknown values that do not begin with `_` are reserved for
future ACP variants.

## ElicitationRequestScope

Request-scoped elicitation, tied to a specific JSON-RPC request outside of a session
(e.g., during auth/configuration phases before any session is started).

**Type:** Object

**Properties:**

**requestId** `[RequestId](#requestid)` *required*

The request this elicitation is tied to.

## ElicitationSchema

Type-safe elicitation schema for requesting structured user input.

This represents a JSON Schema object with primitive-typed properties,
as required by the elicitation specification.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

Optional. Omitted and `null` are equivalent and mean no metadata.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**description** `string | null`

Optional description of what this schema represents.

Optional. Omitted and `null` are equivalent and mean no schema description is provided.

**properties** `object`

Property definitions (must be primitive types).

* Default: `{}`

**required** `"string"[] | null`

List of required property names.

Optional. Omitted and `null` are equivalent and mean no property names are required.

**title** `string | null`

Optional title for the schema.

Optional. Omitted and `null` are equivalent and mean no title is provided.

**type** `[ElicitationSchemaType](#elicitationschematype)`

Type discriminator. Always `"object"`.

* Default: `"object"`

## ElicitationSchemaType

Type discriminator for elicitation schemas.

**Type:** Union

**object** `string`

Object schema type.

## ElicitationSessionScope

Session-scoped elicitation, optionally tied to a specific tool call.

When `toolCallId` is set, the elicitation is tied to a specific tool call.
This is useful when an agent receives an elicitation from an MCP server
during a tool call and needs to redirect it to the user.

**Type:** Object

**Properties:**

**sessionId** `[SessionId](#sessionid)` *required*

The session this elicitation is tied to.

**toolCallId** `[ToolCallId](#toolcallid) | null`

Optional tool call within the session.

Optional. Omitted and `null` are equivalent and mean the elicitation is scoped to the
session without a specific tool call.

## ElicitationUrlCapabilities

URL-based elicitation capabilities.

Supplying `\{\}` means the client supports URL-based elicitation.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

Optional. Omitted and `null` are equivalent and mean no metadata.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

## ElicitationUrlMode

URL-based elicitation mode where the client directs the user to a URL.

**Type:** Union

**Shared properties:**

**elicitationId** `[ElicitationId](#elicitationid)` *required*

The unique identifier for this elicitation.

**url** `string` *required*

The URL to direct the user to.

* Format: `uri`

**Variants:**

**Session**

Tied to a session, optionally to a specific tool call within that session.

**Properties**

**sessionId** `[SessionId](#sessionid)` *required*

The session this elicitation is tied to.

**toolCallId** `[ToolCallId](#toolcallid) | null`

Optional tool call within the session.

Optional. Omitted and `null` are equivalent and mean the elicitation is scoped to the
session without a specific tool call.

**Request**

Tied to a specific JSON-RPC request outside of a session
(e.g., during auth/configuration phases before any session is started).

**Properties**

**requestId** `[RequestId](#requestid)` *required*

The request this elicitation is tied to.

## EmbeddedResource

The contents of a resource, embedded into a prompt or tool call result.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**annotations** `[Annotations](#annotations) | null`

Optional annotations that help clients decide how to display or route this content.

**resource** `[EmbeddedResourceResource](#embeddedresourceresource)` *required*

Embedded resource payload, either text or binary data.

## EmbeddedResourceResource

Resource content that can be embedded in a message.

**Type:** Union

**TextResourceContents**

Text resource contents embedded directly in the message.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**mimeType** `string | null`

MIME type describing the encoded media payload.

**text** `string` *required*

Text payload carried by this content block.

**uri** `string` *required*

URI associated with this resource or media payload.

**BlobResourceContents**

Binary resource contents embedded directly in the message.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**blob** `string` *required*

Base64-encoded bytes for a binary resource payload.

**mimeType** `string | null`

MIME type describing the encoded media payload.

**uri** `string` *required*

URI associated with this resource or media payload.

## EnumOption

A titled enum option with a const value, human-readable title, and optional description.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

Optional. Omitted and `null` are equivalent and mean no metadata.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**const** `string` *required*

The constant value for this option.

**description** `string | null`

Human-readable description.

Optional. Omitted and `null` are equivalent and mean no description is provided.

**title** `string` *required*

Human-readable title for this option.

## EnvVariable

An environment variable to set when launching an MCP server.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**name** `string` *required*

The name of the environment variable.

**value** `string` *required*

The value to set for the environment variable.

## Error

JSON-RPC error object.

Represents an error that occurred during method execution, following the
JSON-RPC 2.0 error object specification with optional additional data.

See protocol docs: [JSON-RPC Error Object](https://www.jsonrpc.org/specification#error_object)

**Type:** Object

**Properties:**

**code** `[ErrorCode](#errorcode)` *required*

A number indicating the error type that occurred. This must be an integer as
defined in the JSON-RPC specification.

**data** `object`

Optional primitive or structured value that contains additional information
about the error. This may include debugging information or context-specific
details.

**message** `string` *required*

A string providing a short description of the error. The message should be
limited to a concise single sentence.

## ErrorCode

Predefined error codes for common JSON-RPC and ACP-specific errors.

Standard errors use the JSON-RPC 2.0 codes. ACP-specific errors use the JSON-RPC
server-error range (-32000 to -32099), and request cancellation uses -32800 from the
range LSP reserves (-32899 to -32800).

**Type:** Union

**-32700** `int32`

**Parse error**: Invalid JSON was received by the server. An error occurred on
the server while parsing the JSON text.

**-32600** `int32`

**Invalid request**: The JSON sent is not a valid Request object.

**-32601** `int32`

**Method not found**: The method does not exist or is not available.

**-32602** `int32`

**Invalid params**: Invalid method parameter(s).

**-32603** `int32`

**Internal error**: Internal JSON-RPC error.

**-32800** `int32`

**Request cancelled**: Execution of the method was aborted either due to a
cancellation request from the caller or because of resource constraints or
shutdown.

**-32000** `int32`

**Authentication required**: Authentication is required before this operation
can be performed.

**-32002** `int32`

**Resource not found**: A given resource, such as a session or file, was not
found.

**Other** `int32`

Other undefined error code.

## ExtNotification

Allows either side to send an arbitrary notification that is not part of the ACP spec.
Extension notifications provide a way to send one-way messages for custom functionality
while maintaining protocol compatibility.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

## ExtRequest

Allows for sending an arbitrary request that is not part of the ACP spec.
Extension methods provide a way to add custom functionality while maintaining
protocol compatibility.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

## ExtResponse

Allows for sending an arbitrary response to an extension request that is not part of the ACP spec.
Extension methods provide a way to add custom functionality while maintaining
protocol compatibility.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

## FileSystemCapabilities

File system capabilities that a client may support.

See protocol docs: [FileSystem](https://agentclientprotocol.com/protocol/v1/initialization.md#filesystem)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**readTextFile** `boolean`

Whether the Client supports `fs/read_text_file` requests.

* Default: `false`

**writeTextFile** `boolean`

Whether the Client supports `fs/write_text_file` requests.

* Default: `false`

## HttpHeader

An HTTP header to set when making requests to the MCP server.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**name** `string` *required*

The name of the HTTP header.

**value** `string` *required*

The value to set for the HTTP header.

## ImageContent

An image provided to or from an LLM.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**annotations** `[Annotations](#annotations) | null`

Optional annotations that help clients decide how to display or route this content.

**data** `string` *required*

Base64-encoded media payload.

**mimeType** `string` *required*

MIME type describing the encoded media payload.

**uri** `string | null`

URI associated with this resource or media payload.

## Implementation

Metadata about the implementation of the client or agent.
Describes the name and version of an ACP implementation, with an optional
title for UI representation.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**name** `string` *required*

Intended for programmatic or logical use, but can be used as a display
name fallback if title isn't present.

**title** `string | null`

Intended for UI and end-user contexts, so it should be readable by people.

If not provided, the name should be used for display.

**version** `string` *required*

Version of the implementation. Can be displayed to the user or used
for debugging or metrics purposes. (e.g. "1.0.0").

## IntegerPropertySchema

Schema for integer properties in an elicitation form.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

Optional. Omitted and `null` are equivalent and mean no metadata.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**default** `integer | null`

Default value.

Optional. Omitted and `null` are equivalent and mean no default value is provided.

**description** `string | null`

Human-readable description.

Optional. Omitted and `null` are equivalent and mean no description is provided.

**maximum** `integer | null`

Maximum value (inclusive).

Optional. Omitted and `null` are equivalent and mean there is no inclusive upper bound.

**minimum** `integer | null`

Minimum value (inclusive).

Optional. Omitted and `null` are equivalent and mean there is no inclusive lower bound.

**title** `string | null`

Optional title for the property.

Optional. Omitted and `null` are equivalent and mean no title is provided.

## LogoutCapabilities

Logout capabilities supported by the agent.

Supplying `\{\}` means the agent supports the logout method.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

## McpCapabilities

MCP capabilities supported by the agent

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**http** `boolean`

Agent supports `http` MCP servers.

* Default: `false`

**sse** `boolean`

Agent supports `sse` MCP servers.

* Default: `false`

## McpServer

Configuration for connecting to an MCP (Model Context Protocol) server.

MCP servers provide tools and context that the agent can use when
processing prompts.

See protocol docs: [MCP Servers](https://agentclientprotocol.com/protocol/v1/session-setup.md#mcp-servers)

**Type:** Union

**http** `object`

HTTP transport configuration

Only available when the Agent capabilities indicate `mcp_capabilities.http` is `true`.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**headers** `[HttpHeader\[\]](#httpheader)` *required*

HTTP headers to set when making requests to the MCP server.

**name** `string` *required*

Human-readable name identifying this MCP server.

**type** `string` *required*

The discriminator value. Must be `"http"`.

**url** `string` *required*

URL to the MCP server.

**sse** `object`

SSE transport configuration

Only available when the Agent capabilities indicate `mcp_capabilities.sse` is `true`.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**headers** `[HttpHeader\[\]](#httpheader)` *required*

HTTP headers to set when making requests to the MCP server.

**name** `string` *required*

Human-readable name identifying this MCP server.

**type** `string` *required*

The discriminator value. Must be `"sse"`.

**url** `string` *required*

URL to the MCP server.

**stdio**

Stdio transport configuration

All Agents MUST support this transport.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**args** `"string"[]` *required*

Command-line arguments to pass to the MCP server.

**command** `string` *required*

Absolute path to the MCP server executable.

**env** `[EnvVariable\[\]](#envvariable)` *required*

Environment variables to set when launching the MCP server.

**name** `string` *required*

Human-readable name identifying this MCP server.

## McpServerHttp

HTTP transport configuration for MCP.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**headers** `[HttpHeader\[\]](#httpheader)` *required*

HTTP headers to set when making requests to the MCP server.

**name** `string` *required*

Human-readable name identifying this MCP server.

**url** `string` *required*

URL to the MCP server.

## McpServerSse

SSE transport configuration for MCP.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**headers** `[HttpHeader\[\]](#httpheader)` *required*

HTTP headers to set when making requests to the MCP server.

**name** `string` *required*

Human-readable name identifying this MCP server.

**url** `string` *required*

URL to the MCP server.

## McpServerStdio

Stdio transport configuration for MCP.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**args** `"string"[]` *required*

Command-line arguments to pass to the MCP server.

**command** `string` *required*

Absolute path to the MCP server executable.

**env** `[EnvVariable\[\]](#envvariable)` *required*

Environment variables to set when launching the MCP server.

**name** `string` *required*

Human-readable name identifying this MCP server.

## MessageId

Unique identifier for a message within a session.

**Type:** `string`

## MultiSelectItems

Items for a multi-select (array) property schema.

**Type:** Union

**string** `object`

Multi-select string items with plain string values.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

Optional. Omitted and `null` are equivalent and mean no metadata.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**enum** `"string"[]` *required*

Allowed enum values.

**type** `string` *required*

The discriminator value. Must be `"string"`.

**other** `object`

Custom or future typed multi-select items.

**Properties**

**type** `string` *required*

Custom or future multi-select item type.

Values beginning with `_` are reserved for implementation-specific
extensions. Unknown values that do not begin with `_` are reserved for
future ACP variants.

**titled**

Titled multi-select items with human-readable labels.

As in MCP, titled items omit `type` and are identified by `anyOf`.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

Optional. Omitted and `null` are equivalent and mean no metadata.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**anyOf** `[EnumOption\[\]](#enumoption)` *required*

Titled enum options.

## MultiSelectPropertySchema

Schema for multi-select (array) properties in an elicitation form.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

Optional. Omitted and `null` are equivalent and mean no metadata.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**default** `"string"[] | null`

Default selected values.

Optional. Omitted and `null` are equivalent and mean no default selections are provided.

**description** `string | null`

Human-readable description.

Optional. Omitted and `null` are equivalent and mean no description is provided.

**items** `[MultiSelectItems](#multiselectitems)` *required*

The items definition describing allowed values.

**maxItems** `integer | null`

Maximum number of items to select.

Optional. Omitted and `null` are equivalent and mean there is no maximum selection count.

* Minimum: `0`

**minItems** `integer | null`

Minimum number of items to select.

Optional. Omitted and `null` are equivalent and mean there is no minimum selection count.

* Minimum: `0`

**title** `string | null`

Optional title for the property.

Optional. Omitted and `null` are equivalent and mean no title is provided.

## Notice

Fire-and-forget information for the user.

Notices are live events rather than session history. Agents must not rely on
a notice being received, displayed, or seen by the user.
Agents MUST only send notices when the Client advertised
the `session.notices` Client capability. Otherwise, Agents may use an agent
message when the information should still be surfaced to the user.

See RFD: [Session Notices](https://agentclientprotocol.com/rfds/session-notices.md)

**Type:** Object

**Properties:**

**\_meta** `object | null`

Metadata scoped to this notice.

Omitted and `null` are equivalent and mean no metadata was supplied.

**description** `string | null`

Optional plain-text detail or guidance.

Omitted and `null` are equivalent and mean no description was supplied.

**severity** `[NoticeSeverity](#noticeseverity)` *required*

Presentation severity hint.

**title** `string` *required*

Required non-empty plain-text title that can stand alone.

* Min length: `1`

## NoticeCapabilities

Client support for presenting live notices to the user.

**Type:** `object`

## NoticeSeverity

Severity hint for a session notice.

**Type:** Union

**info** `string`

Informational notice.

**warning** `string`

Warning notice.

**error** `string`

Error notice.

**other** `string`

Custom or future notice severity.

Values beginning with `_` are reserved for implementation-specific
extensions. Other unknown values are reserved for future ACP severities.

## NumberPropertySchema

Schema for number (floating-point) properties in an elicitation form.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

Optional. Omitted and `null` are equivalent and mean no metadata.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**default** `number | null`

Default value.

Optional. Omitted and `null` are equivalent and mean no default value is provided.

**description** `string | null`

Human-readable description.

Optional. Omitted and `null` are equivalent and mean no description is provided.

**maximum** `number | null`

Maximum value (inclusive).

Optional. Omitted and `null` are equivalent and mean there is no inclusive upper bound.

**minimum** `number | null`

Minimum value (inclusive).

Optional. Omitted and `null` are equivalent and mean there is no inclusive lower bound.

**title** `string | null`

Optional title for the property.

Optional. Omitted and `null` are equivalent and mean no title is provided.

## PermissionOption

An option presented to the user when requesting permission.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**kind** `[PermissionOptionKind](#permissionoptionkind)` *required*

Hint about the nature of this permission option.

**name** `string` *required*

Human-readable label to display to the user.

**optionId** `[PermissionOptionId](#permissionoptionid)` *required*

Unique identifier for this permission option.

## PermissionOptionId

Unique identifier for a permission option.

**Type:** `string`

## PermissionOptionKind

The type of permission option being presented to the user.

Helps clients choose appropriate icons and UI treatment.

**Type:** Union

**allow\_once** `string`

Allow this operation only this time.

**allow\_always** `string`

Allow this operation and remember the choice.

**reject\_once** `string`

Reject this operation only this time.

**reject\_always** `string`

Reject this operation and remember the choice.

## Plan

An execution plan for accomplishing complex tasks.

Plans consist of multiple entries representing individual tasks or goals.
Agents report plans to clients to provide visibility into their execution strategy.
Plans can evolve during execution as the agent discovers new requirements or completes tasks.

See protocol docs: [Agent Plan](https://agentclientprotocol.com/protocol/v1/agent-plan.md)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**entries** `[PlanEntry\[\]](#planentry)` *required*

The list of tasks to be accomplished.

When updating a plan, the agent must send a complete list of all entries
with their current status. The client replaces the entire plan with each update.

## PlanEntry

A single entry in the execution plan.

Represents a task or goal that the assistant intends to accomplish
as part of fulfilling the user's request.
See protocol docs: [Plan Entries](https://agentclientprotocol.com/protocol/v1/agent-plan.md#plan-entries)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**content** `string` *required*

Human-readable description of what this task aims to accomplish.

**priority** `[PlanEntryPriority](#planentrypriority)` *required*

The relative importance of this task.
Used to indicate which tasks are most critical to the overall goal.

**status** `[PlanEntryStatus](#planentrystatus)` *required*

Current execution status of this task.

## PlanEntryPriority

Priority levels for plan entries.

Used to indicate the relative importance or urgency of different
tasks in the execution plan.
See protocol docs: [Plan Entries](https://agentclientprotocol.com/protocol/v1/agent-plan.md#plan-entries)

**Type:** Union

**high** `string`

High priority task - critical to the overall goal.

**medium** `string`

Medium priority task - important but not critical.

**low** `string`

Low priority task - nice to have but not essential.

## PlanEntryStatus

Status of a plan entry in the execution flow.

Tracks the lifecycle of each task from planning through completion.
See protocol docs: [Plan Entries](https://agentclientprotocol.com/protocol/v1/agent-plan.md#plan-entries)

**Type:** Union

**pending** `string`

The task has not started yet.

**in\_progress** `string`

The task is currently being worked on.

**completed** `string`

The task has been successfully completed.

## PromptCapabilities

Prompt capabilities supported by the agent in `session/prompt` requests.

Baseline agent functionality requires support for `text`
and `resource_link` content blocks in prompt requests.

Other variants must be explicitly opted in to.
Capabilities for different types of content in prompt requests.

Indicates which content types beyond the baseline (text and resource links)
the agent can process.

See protocol docs: [Prompt Capabilities](https://agentclientprotocol.com/protocol/v1/initialization.md#prompt-capabilities)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**audio** `boolean`

Agent supports `audio` content blocks.

* Default: `false`

**embeddedContext** `boolean`

Agent supports embedded context in `session/prompt` requests.

When enabled, the Client is allowed to include `resource` content blocks
in prompt requests for pieces of context that are referenced in the message.

* Default: `false`

**image** `boolean`

Agent supports `image` content blocks.

* Default: `false`

## ProtocolVersion

Protocol version identifier.

This version is only bumped for breaking changes.
Non-breaking changes should be introduced via capabilities.

**Type:** `integer (uint16)`

| Constraint | Value |
| - | - |
| Minimum | `0` |
| Maximum | `65535` |

## RequestId

JSON RPC Request Id

An identifier established by the Client that MUST contain a String, Number, or NULL value if included. If it is not included it is assumed to be a notification. The value SHOULD normally not be Null \[1] and Numbers SHOULD NOT contain fractional parts \[2]

The Server MUST reply with the same value in the Response object if included. This member is used to correlate the context between the two objects.

\[1] The use of Null as a value for the id member in a Request object is discouraged, because this specification uses a value of Null for Responses with an unknown id. Also, because JSON-RPC 1.0 uses an id value of Null for Notifications this could cause confusion in handling.

\[2] Fractional parts may be problematic, since many decimal fractions cannot be represented exactly as binary fractions.

**Type:** Union

**null** `null`

The JSON-RPC `null` request id.

**Number** `int64`

A numeric JSON-RPC request id.

**Str** `string`

A string JSON-RPC request id.

## RequestPermissionOutcome

The outcome of a permission request.

**Type:** Union

**cancelled** `object`

The prompt turn was cancelled before the user responded.

When a client sends a `session/cancel` notification to cancel an ongoing
prompt turn, it MUST respond to all pending `session/request_permission`
requests with this `cancelled` outcome.

See protocol docs: [Cancellation](https://agentclientprotocol.com/protocol/v1/prompt-turn.md#cancellation)

**Properties**

**outcome** `string` *required*

The discriminator value. Must be `"cancelled"`.

**selected** `object`

The user selected one of the provided options.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**optionId** `[PermissionOptionId](#permissionoptionid)` *required*

The ID of the option the user selected.

**outcome** `string` *required*

The discriminator value. Must be `"selected"`.

## ResourceLink

A resource that the server is capable of reading, included in a prompt or tool call result.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**annotations** `[Annotations](#annotations) | null`

Optional annotations that help clients decide how to display or route this content.

**description** `string | null`

Optional human-readable details shown with this protocol object.

**mimeType** `string | null`

MIME type describing the encoded media payload.

**name** `string` *required*

Human-readable name shown for this protocol object.

**size** `integer | null`

Optional size of the linked resource in bytes, if known.

**title** `string | null`

Optional display title for end-user UI.

**uri** `string` *required*

URI associated with this resource or media payload.

## Role

The sender or recipient of messages and data in a conversation.

**Type:** Union

**assistant** `string`

The assistant side of a conversation.

**user** `string`

The user side of a conversation.

## SelectedPermissionOutcome

The user selected one of the provided options.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**optionId** `[PermissionOptionId](#permissionoptionid)` *required*

The ID of the option the user selected.

## SessionAdditionalDirectoriesCapabilities

Capabilities for additional session directories support.

Supplying `\{\}` means the agent supports the `additionalDirectories` field on
supported session lifecycle requests. Agents that also support
`session/list` may return `SessionInfo.additionalDirectories` to report the
complete ordered additional-root list associated with a listed session.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

## SessionCapabilities

Session capabilities supported by the agent.

As a baseline, all Agents **MUST** support `session/new`, `session/prompt`, `session/cancel`, and `session/update`.

Optionally, they **MAY** support other session methods and notifications by specifying additional capabilities.

Note: `session/load` is still handled by the top-level `loadSession` capability. This will be unified in future versions of the protocol.

See protocol docs: [Session Capabilities](https://agentclientprotocol.com/protocol/v1/initialization.md#session-capabilities)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**additionalDirectories** `[SessionAdditionalDirectoriesCapabilities](#sessionadditionaldirectoriescapabilities) | null`

Whether the agent supports `additionalDirectories` on supported session lifecycle requests.

Optional. Omitted or `null` both mean the agent does not advertise support.
Supplying `\{\}` means the agent supports `additionalDirectories` on
supported session lifecycle requests.

Agents that also support `session/list` may return
`SessionInfo.additionalDirectories` to report the complete ordered
additional-root list associated with a listed session.

**close** `[SessionCloseCapabilities](#sessionclosecapabilities) | null`

Whether the agent supports `session/close`.

Optional. Omitted or `null` both mean the agent does not advertise support.
Supplying `\{\}` means the agent supports closing sessions.

**delete** `[SessionDeleteCapabilities](#sessiondeletecapabilities) | null`

Whether the agent supports `session/delete`.

Optional. Omitted or `null` both mean the agent does not advertise support.
Supplying `\{\}` means the agent supports deleting sessions from `session/list`.

**list** `[SessionListCapabilities](#sessionlistcapabilities) | null`

Whether the agent supports `session/list`.

Optional. Omitted or `null` both mean the agent does not advertise support.
Supplying `\{\}` means the agent supports listing sessions.

**resume** `[SessionResumeCapabilities](#sessionresumecapabilities) | null`

Whether the agent supports `session/resume`.

Optional. Omitted or `null` both mean the agent does not advertise support.
Supplying `\{\}` means the agent supports resuming sessions.

## SessionCloseCapabilities

Capabilities for the `session/close` method.

Supplying `\{\}` means the agent supports closing sessions.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

## SessionConfigBoolean

A boolean on/off toggle session configuration option payload.

**Type:** Object

**Properties:**

**currentValue** `boolean` *required*

The current value of the boolean option.

## SessionConfigGroupId

Unique identifier for a session configuration option value group.

**Type:** `string`

## SessionConfigId

Unique identifier for a session configuration option.

**Type:** `string`

## SessionConfigOption

A session configuration option selector and its current state.

**Type:** Union

**Shared properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**category** `[SessionConfigOptionCategory](#sessionconfigoptioncategory) | null`

Optional semantic category for this option (UX only).

**description** `string | null`

Optional description for the Client to display to the user.

**id** `[SessionConfigId](#sessionconfigid)` *required*

Unique identifier for the configuration option.

**name** `string` *required*

Human-readable label for the option.

**Variants:**

**select** `object`

Single-value selector (dropdown).

**Properties**

**currentValue** `[SessionConfigValueId](#sessionconfigvalueid)` *required*

The currently selected value.

**options** `[SessionConfigSelectOptions](#sessionconfigselectoptions)` *required*

The set of selectable options.

**type** `string` *required*

The discriminator value. Must be `"select"`.

**boolean** `object`

Boolean on/off toggle.

**Properties**

**currentValue** `boolean` *required*

The current value of the boolean option.

**type** `string` *required*

The discriminator value. Must be `"boolean"`.

## SessionConfigOptionCategory

Semantic category for a session configuration option.

This is intended to help Clients distinguish broadly common selectors (e.g. model selector vs
session mode selector vs thought/reasoning level) for UX purposes (keyboard shortcuts, icons,
placement). It MUST NOT be required for correctness. Clients MUST handle missing or unknown
categories gracefully.

Category names beginning with `_` are free for custom use, like other ACP extension methods.
Category names that do not begin with `_` are reserved for the ACP spec.

**Type:** Union

**mode** `string`

Session mode selector.

**model** `string`

Model selector.

**model\_config** `string`

Model-related configuration parameter.

**thought\_level** `string`

Thought/reasoning level selector.

**other** `string`

Unknown / uncategorized selector.

## SessionConfigOptionsCapabilities

Session configuration option capabilities supported by the client.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**boolean** `[BooleanConfigOptionCapabilities](#booleanconfigoptioncapabilities) | null`

Whether the client supports boolean session configuration options.

Optional. Omitted or `null` both mean the client does not advertise support.
Supplying `\{\}` means agents may include `type: "boolean"` entries in
`configOptions`, and the client may send `session/set_config_option`
requests with `type: "boolean"` and a boolean `value`.

## SessionConfigSelect

A single-value selector (dropdown) session configuration option payload.

**Type:** Object

**Properties:**

**currentValue** `[SessionConfigValueId](#sessionconfigvalueid)` *required*

The currently selected value.

**options** `[SessionConfigSelectOptions](#sessionconfigselectoptions)` *required*

The set of selectable options.

## SessionConfigSelectGroup

A group of possible values for a session configuration option.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**group** `[SessionConfigGroupId](#sessionconfiggroupid)` *required*

Unique identifier for this group.

**name** `string` *required*

Human-readable label for this group.

**options** `[SessionConfigSelectOption\[\]](#sessionconfigselectoption)` *required*

The set of option values in this group.

## SessionConfigSelectOption

A possible value for a session configuration option.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**description** `string | null`

Optional description for this option value.

**name** `string` *required*

Human-readable label for this option value.

**value** `[SessionConfigValueId](#sessionconfigvalueid)` *required*

Unique identifier for this option value.

## SessionConfigSelectOptions

Possible values for a session configuration option.

**Type:** Union

**Ungrouped** `array`

A flat list of options with no grouping.

**Grouped** `array`

A list of options grouped under headers.

## SessionConfigValueId

Unique identifier for a session configuration option value.

**Type:** `string`

## SessionDeleteCapabilities

Capabilities for the `session/delete` method.

Supplying `\{\}` means the agent supports deleting sessions from `session/list`.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

## SessionId

A unique identifier for a conversation session between a client and agent.

Each session has its own context, conversation history, and state, so one
agent can run several independent sessions.

See protocol docs: [Session ID](https://agentclientprotocol.com/protocol/v1/session-setup.md#session-id)

**Type:** `string`

## SessionInfo

Information about a session returned by session/list

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**additionalDirectories** `"string"[]`

Additional workspace roots reported for this session. Each path must be absolute.

When present, this is the complete ordered additional-root list reported
by the Agent. Omitted and empty values are equivalent: the response
reports no additional roots.

**cwd** `string` *required*

The working directory for this session. Must be an absolute path.

**sessionId** `[SessionId](#sessionid)` *required*

Unique identifier for the session

**title** `string | null`

Human-readable title for the session

**updatedAt** `string | null`

ISO 8601 timestamp of last activity

## SessionInfoUpdate

Update to session metadata. All fields are optional to support partial updates.

Agents send this notification to update session information like title or custom metadata.
Clients can use it to keep session titles and state current.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**title** `string | null`

Human-readable title for the session. Set to null to clear.

**updatedAt** `string | null`

ISO 8601 timestamp of last activity. Set to null to clear.

## SessionListCapabilities

Capabilities for the `session/list` method.

Supplying `\{\}` means the agent supports listing sessions.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

## SessionMode

A mode the agent can operate in.

See protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/v1/session-modes.md)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**description** `string | null`

Optional human-readable details shown with this protocol object.

**id** `[SessionModeId](#sessionmodeid)` *required*

Stable identifier used to refer to this protocol object in later messages.

**name** `string` *required*

Human-readable name shown for this protocol object.

## SessionModeId

Unique identifier for a Session Mode.

**Type:** `string`

## SessionModeState

The set of modes and the one currently active.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**availableModes** `[SessionMode\[\]](#sessionmode)` *required*

The set of modes that the Agent can operate in

**currentModeId** `[SessionModeId](#sessionmodeid)` *required*

The current mode the Agent is in.

## SessionResumeCapabilities

Capabilities for the `session/resume` method.

Supplying `\{\}` means the agent supports resuming sessions.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

## SessionUpdate

Different types of updates that can be sent during session processing.

These updates provide real-time feedback about the agent's progress.

See protocol docs: [Agent Reports Output](https://agentclientprotocol.com/protocol/v1/prompt-turn.md#3-agent-reports-output)

**Type:** Union

**user\_message\_chunk** `object`

A chunk of the user's message being streamed.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**content** `[ContentBlock](#contentblock)` *required*

A single item of content

**messageId** `[MessageId](#messageid) | null`

A unique identifier for the message this chunk belongs to.

All chunks belonging to the same message share the same `messageId`.
A change in `messageId` indicates a new message has started.

**sessionUpdate** `string` *required*

The discriminator value. Must be `"user_message_chunk"`.

**agent\_message\_chunk** `object`

A chunk of the agent's response being streamed.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**content** `[ContentBlock](#contentblock)` *required*

A single item of content

**messageId** `[MessageId](#messageid) | null`

A unique identifier for the message this chunk belongs to.

All chunks belonging to the same message share the same `messageId`.
A change in `messageId` indicates a new message has started.

**sessionUpdate** `string` *required*

The discriminator value. Must be `"agent_message_chunk"`.

**agent\_thought\_chunk** `object`

A chunk of the agent's internal reasoning being streamed.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**content** `[ContentBlock](#contentblock)` *required*

A single item of content

**messageId** `[MessageId](#messageid) | null`

A unique identifier for the message this chunk belongs to.

All chunks belonging to the same message share the same `messageId`.
A change in `messageId` indicates a new message has started.

**sessionUpdate** `string` *required*

The discriminator value. Must be `"agent_thought_chunk"`.

**tool\_call** `object`

Notification that a new tool call has been initiated.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**content** `[ToolCallContent\[\]](#toolcallcontent)`

Content produced by the tool call.

**kind** `[ToolKind](#toolkind)`

The category of tool being invoked.
Helps clients choose appropriate icons and UI treatment.

**locations** `[ToolCallLocation\[\]](#toolcalllocation)`

File locations affected by this tool call.
Enables "follow-along" features in clients.

**name** `string | null`

Programmatic name of the tool being invoked.

This field is optional. Omitting it or sending `null` both mean that no
tool name is available.

**rawInput** `object`

Raw input parameters sent to the tool.

**rawOutput** `object`

Raw output returned by the tool.

**sessionUpdate** `string` *required*

The discriminator value. Must be `"tool_call"`.

**status** `[ToolCallStatus](#toolcallstatus)`

Current execution status of the tool call.

**title** `string` *required*

Human-readable title describing what the tool is doing.

**toolCallId** `[ToolCallId](#toolcallid)` *required*

Unique identifier for this tool call within the session.

**tool\_call\_update** `object`

Update on the status or results of a tool call.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**content** `[ToolCallContent\[\]](#toolcallcontent) | null`

Replace the content collection.

**kind** `[ToolKind](#toolkind) | null`

Update the tool kind.

**locations** `[ToolCallLocation\[\]](#toolcalllocation) | null`

Replace the locations collection.

**name** `string | null`

Update the programmatic name of the tool being invoked.

This field is optional. Omitting it or sending `null` both mean that
the existing name is left unchanged.

**rawInput** `object`

Update the raw input.

**rawOutput** `object`

Update the raw output.

**sessionUpdate** `string` *required*

The discriminator value. Must be `"tool_call_update"`.

**status** `[ToolCallStatus](#toolcallstatus) | null`

Update the execution status.

**title** `string | null`

Update the human-readable title.

**toolCallId** `[ToolCallId](#toolcallid)` *required*

The ID of the tool call being updated.

**plan** `object`

The agent's execution plan for complex tasks.
See protocol docs: [Agent Plan](https://agentclientprotocol.com/protocol/v1/agent-plan.md)

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**entries** `[PlanEntry\[\]](#planentry)` *required*

The list of tasks to be accomplished.

When updating a plan, the agent must send a complete list of all entries
with their current status. The client replaces the entire plan with each update.

**sessionUpdate** `string` *required*

The discriminator value. Must be `"plan"`.

**available\_commands\_update** `object`

Available commands are ready or have changed

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**availableCommands** `[AvailableCommand\[\]](#availablecommand)` *required*

Commands the agent can execute

**sessionUpdate** `string` *required*

The discriminator value. Must be `"available_commands_update"`.

**current\_mode\_update** `object`

The current mode of the session has changed

See protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/v1/session-modes.md)

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**currentModeId** `[SessionModeId](#sessionmodeid)` *required*

The ID of the current mode

**sessionUpdate** `string` *required*

The discriminator value. Must be `"current_mode_update"`.

**config\_option\_update** `object`

Session configuration options have been updated.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**configOptions** `[SessionConfigOption\[\]](#sessionconfigoption)` *required*

The full set of configuration options and their current values.

**sessionUpdate** `string` *required*

The discriminator value. Must be `"config_option_update"`.

**session\_info\_update** `object`

Session metadata has been updated (title, timestamps, custom metadata)

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**sessionUpdate** `string` *required*

The discriminator value. Must be `"session_info_update"`.

**title** `string | null`

Human-readable title for the session. Set to null to clear.

**updatedAt** `string | null`

ISO 8601 timestamp of last activity. Set to null to clear.

**usage\_update** `object`

Context window and cost update for the session.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**cost** `[Cost](#cost) | null`

Cumulative session cost (optional).

**sessionUpdate** `string` *required*

The discriminator value. Must be `"usage_update"`.

**size** `uint64` *required*

Total context window size in tokens.

* Minimum: `0`

**used** `uint64` *required*

Tokens currently in context.

* Minimum: `0`

**notice** `object`

Information for the user that is not part of session history.

Agents MUST only send this update when the Client advertised
the `session.notices` Client capability.

**Properties**

**\_meta** `object | null`

Metadata scoped to this notice.

Omitted and `null` are equivalent and mean no metadata was supplied.

**description** `string | null`

Optional plain-text detail or guidance.

Omitted and `null` are equivalent and mean no description was supplied.

**sessionUpdate** `string` *required*

The discriminator value. Must be `"notice"`.

**severity** `[NoticeSeverity](#noticeseverity)` *required*

Presentation severity hint.

**title** `string` *required*

Required non-empty plain-text title that can stand alone.

* Min length: `1`

**compaction\_update** `object`

A context compaction has been created or updated.

Agents MUST only send this update when the Client advertised
the `session.compaction` Client capability.

**Properties**

**\_meta** `object | null`

Extensible metadata patch for this compaction.

**compactionId** `[CompactionId](#compactionid)` *required*

The Agent-owned ID of this compaction, unique within the session.

**error** `string | null`

Human-readable error details for the compaction.

**sessionUpdate** `string` *required*

The discriminator value. Must be `"compaction_update"`.

**status** `[CompactionStatus](#compactionstatus)` *required*

Current lifecycle status.

**summary** \`[ContentBlock\[\]](#contentblock)

\| null\`

Complete replacement user-displayable summary content for the compaction.

**compaction\_summary\_chunk** `object`

A content block appended to a context compaction's retained summary.

Agents MUST only send this update when the Client advertised
the `session.compaction` Client capability.

**Properties**

**\_meta** `object | null`

Metadata scoped to this chunk. Omission and `null` both mean absent.

**compactionId** `[CompactionId](#compactionid)` *required*

ID of the compaction whose summary receives this content.

**content** `[ContentBlock](#contentblock)` *required*

One content block to append.

**sessionUpdate** `string` *required*

The discriminator value. Must be `"compaction_summary_chunk"`.

## StopReason

Reasons why an agent stops processing a prompt turn.

See protocol docs: [Stop Reasons](https://agentclientprotocol.com/protocol/v1/prompt-turn.md#stop-reasons)

**Type:** Union

**end\_turn** `string`

The turn ended successfully.

**max\_tokens** `string`

The turn ended because the agent reached the maximum number of tokens.

**max\_turn\_requests** `string`

The turn ended because the agent reached the maximum number of allowed agent
requests between user turns.

**refusal** `string`

The turn ended because the agent refused to continue. The user prompt and
everything that comes after it won't be included in the next prompt, so this
should be reflected in the UI.

**cancelled** `string`

The turn was cancelled by the client via `session/cancel`.

This stop reason MUST be returned when the client sends a `session/cancel`
notification, even if the cancellation causes exceptions in underlying operations.
Agents should catch these exceptions and return this semantically meaningful
response to confirm successful cancellation.

## StringFormat

String format types for string properties in elicitation schemas.

**Type:** Union

**email** `string`

Email address format.

**uri** `string`

URI format.

**date** `string`

Date format (YYYY-MM-DD).

**date-time** `string`

Date-time format (ISO 8601).

## StringMultiSelectItems

String item schema for multi-select enum properties.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

Optional. Omitted and `null` are equivalent and mean no metadata.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**enum** `"string"[]` *required*

Allowed enum values.

## StringPropertySchema

Schema for string properties in an elicitation form.

When `enum` or `oneOf` is set, this represents a single-select enum
with `"type": "string"`.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

Optional. Omitted and `null` are equivalent and mean no metadata.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**default** `string | null`

Default value.

Optional. Omitted and `null` are equivalent and mean no default value is provided.

**description** `string | null`

Human-readable description.

Optional. Omitted and `null` are equivalent and mean no description is provided.

**enum** `"string"[] | null`

Enum values for untitled single-select enums.
Optional. Omitted and `null` are equivalent and mean no untitled single-select choices are
declared by `enum`.

**format** `[StringFormat](#stringformat) | null`

String format.

Optional. Omitted and `null` are equivalent and mean there is no format constraint.

**maxLength** `integer | null`

Maximum string length.

Optional. Omitted and `null` are equivalent and mean there is no maximum length constraint.

* Minimum: `0`

**minLength** `integer | null`

Minimum string length.

Optional. Omitted and `null` are equivalent and mean there is no minimum length constraint.

* Minimum: `0`

**oneOf** `[EnumOption\[\]](#enumoption) | null`

Titled enum options for titled single-select enums.
Optional. Omitted and `null` are equivalent and mean no titled single-select choices are
declared by `oneOf`.

**pattern** `string | null`

Pattern the string must match.

Optional. Omitted and `null` are equivalent and mean there is no pattern constraint.

**title** `string | null`

Optional title for the property.

Optional. Omitted and `null` are equivalent and mean no title is provided.

## Terminal

Embed a terminal created with `terminal/create` by its id.

The terminal must be added before calling `terminal/release`.

See protocol docs: [Terminal](https://agentclientprotocol.com/protocol/v1/terminals.md)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**terminalId** `[TerminalId](#terminalid)` *required*

Identifier of the terminal instance to embed in the content stream.

## TerminalExitStatus

Exit status of a terminal command.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**exitCode** `integer | null`

The process exit code (may be null if terminated by signal).

* Minimum: `0`

**signal** `string | null`

The signal that terminated the process (may be null if exited normally).

## TerminalId

Typed identifier used for terminal values on the wire.

**Type:** `string`

## TextContent

Text provided to or from an LLM.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**annotations** `[Annotations](#annotations) | null`

Optional annotations that help clients decide how to display or route this content.

**text** `string` *required*

Text payload carried by this content block.

## TextResourceContents

Text-based resource contents.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**mimeType** `string | null`

MIME type describing the encoded media payload.

**text** `string` *required*

Text payload carried by this content block.

**uri** `string` *required*

URI associated with this resource or media payload.

## TitledMultiSelectItems

Items definition for titled multi-select enum properties.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

Optional. Omitted and `null` are equivalent and mean no metadata.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**anyOf** `[EnumOption\[\]](#enumoption)` *required*

Titled enum options.

## ToolCall

Represents a tool call that the language model has requested.

Tool calls are actions that the agent executes on behalf of the language model,
such as reading files, executing code, or fetching data from external sources.

See protocol docs: [Tool Calls](https://agentclientprotocol.com/protocol/v1/tool-calls.md)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**content** `[ToolCallContent\[\]](#toolcallcontent)`

Content produced by the tool call.

**kind** `[ToolKind](#toolkind)`

The category of tool being invoked.
Helps clients choose appropriate icons and UI treatment.

**locations** `[ToolCallLocation\[\]](#toolcalllocation)`

File locations affected by this tool call.
Enables "follow-along" features in clients.

**name** `string | null`

Programmatic name of the tool being invoked.

This field is optional. Omitting it or sending `null` both mean that no
tool name is available.

**rawInput** `object`

Raw input parameters sent to the tool.

**rawOutput** `object`

Raw output returned by the tool.

**status** `[ToolCallStatus](#toolcallstatus)`

Current execution status of the tool call.

**title** `string` *required*

Human-readable title describing what the tool is doing.

**toolCallId** `[ToolCallId](#toolcallid)` *required*

Unique identifier for this tool call within the session.

## ToolCallContent

Content produced by a tool call.

Tool calls can produce different types of content including
standard content blocks (text, images) or file diffs.

See protocol docs: [Content](https://agentclientprotocol.com/protocol/v1/tool-calls.md#content)

**Type:** Union

**content** `object`

Standard content block (text, images, resources).

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**content** `[ContentBlock](#contentblock)` *required*

The actual content block.

**type** `string` *required*

The discriminator value. Must be `"content"`.

**diff** `object`

File modification shown as a diff.

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**newText** `string` *required*

The new content after modification.

**oldText** `string | null`

The original content (omitted or `null` for new files).

**path** `string` *required*

The absolute file path being modified.

**type** `string` *required*

The discriminator value. Must be `"diff"`.

**terminal** `object`

Embed a terminal created with `terminal/create` by its id.

The terminal must be added before calling `terminal/release`.

See protocol docs: [Terminal](https://agentclientprotocol.com/protocol/v1/terminals.md)

**Properties**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**terminalId** `[TerminalId](#terminalid)` *required*

Identifier of the terminal instance to embed in the content stream.

**type** `string` *required*

The discriminator value. Must be `"terminal"`.

## ToolCallId

Unique identifier for a tool call within a session.

**Type:** `string`

## ToolCallLocation

A file location being accessed or modified by a tool.

Enables clients to implement "follow-along" features that track
which files the agent is working with in real-time.

See protocol docs: [Following the Agent](https://agentclientprotocol.com/protocol/v1/tool-calls.md#following-the-agent)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**line** `integer | null`

Optional 1-based line number within the file.

* Minimum: `0`

**path** `string` *required*

The absolute file path being accessed or modified.

## ToolCallStatus

Execution status of a tool call.

Tool calls progress through different statuses during their lifecycle.

See protocol docs: [Status](https://agentclientprotocol.com/protocol/v1/tool-calls.md#status)

**Type:** Union

**pending** `string`

The tool call hasn't started running yet because the input is either streaming
or we're awaiting approval.

**in\_progress** `string`

The tool call is currently running.

**completed** `string`

The tool call completed successfully.

**failed** `string`

The tool call failed with an error.

## ToolCallUpdate

An update to an existing tool call.

Used to report progress and results as tools execute. All fields except
the tool call ID are optional - only changed fields need to be included.

See protocol docs: [Updating](https://agentclientprotocol.com/protocol/v1/tool-calls.md#updating)

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**content** `[ToolCallContent\[\]](#toolcallcontent) | null`

Replace the content collection.

**kind** `[ToolKind](#toolkind) | null`

Update the tool kind.

**locations** `[ToolCallLocation\[\]](#toolcalllocation) | null`

Replace the locations collection.

**name** `string | null`

Update the programmatic name of the tool being invoked.

This field is optional. Omitting it or sending `null` both mean that
the existing name is left unchanged.

**rawInput** `object`

Update the raw input.

**rawOutput** `object`

Update the raw output.

**status** `[ToolCallStatus](#toolcallstatus) | null`

Update the execution status.

**title** `string | null`

Update the human-readable title.

**toolCallId** `[ToolCallId](#toolcallid)` *required*

The ID of the tool call being updated.

## ToolKind

Categories of tools that can be invoked.

Tool kinds help clients choose appropriate icons and optimize how they
display tool execution progress.

See protocol docs: [Creating](https://agentclientprotocol.com/protocol/v1/tool-calls.md#creating)

**Type:** Union

**read** `string`

Reading files or data.

**edit** `string`

Modifying files or content.

**delete** `string`

Removing files or data.

**move** `string`

Moving or renaming files.

**search** `string`

Searching for information.

**execute** `string`

Running commands or code.

**think** `string`

Internal reasoning or planning.

**fetch** `string`

Retrieving external data.

**switch\_mode** `string`

Switching the current session mode.

**other** `string`

Other tool types (default).

## UnstructuredCommandInput

All text that was typed after the command name is provided as input.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**hint** `string` *required*

A hint to display when the input hasn't been provided yet

## UsageUpdate

Context window and cost update for a session.

**Type:** Object

**Properties:**

**\_meta** `object | null`

The \_meta property is reserved by ACP to allow clients and agents to attach additional
metadata to their interactions. Implementations MUST NOT make assumptions about values at
these keys.

See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)

**cost** `[Cost](#cost) | null`

Cumulative session cost (optional).

**size** `uint64` *required*

Total context window size in tokens.

* Minimum: `0`

**used** `uint64` *required*

Tokens currently in context.

* Minimum: `0`


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.