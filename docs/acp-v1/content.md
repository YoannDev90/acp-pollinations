> ## Documentation Index
> Fetch the complete documentation index at: https://agentclientprotocol.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Content

> Understanding content blocks in the Agent Client Protocol

A content block is one piece of user-facing content: text, an image, audio, a link to a resource, or an embedded resource.

Content blocks appear in:

* User prompts sent via [`session/prompt`](https://agentclientprotocol.com/protocol/v1/prompt-turn#1-user-message)
* Language model output streamed through [`session/update`](https://agentclientprotocol.com/protocol/v1/prompt-turn#3-agent-reports-output) notifications
* Progress updates and results from [tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls.md)

## Content types

Content from the Agent is untrusted. See [Rendering Agent Content](https://agentclientprotocol.com/protocol/v1/security.md#rendering-agent-content) and [URIs and Remote Resources](https://agentclientprotocol.com/protocol/v1/security.md#uris-and-remote-resources).

ACP's `ContentBlock` is compatible with, and a superset of, the [Model Context Protocol (MCP) 2025-06-18 `ContentBlock`](https://modelcontextprotocol.io/specification/2025-06-18/schema#contentblock), so Agents can forward content from MCP tool outputs unchanged. ACP adds an optional `uri` on image content.

### Text content

Text may be plain text or Markdown. Clients **SHOULD** render it as Markdown. See [Rendering Agent Content](https://agentclientprotocol.com/protocol/v1/security.md#rendering-agent-content) for raw HTML.

```json theme={null}
{
  "type": "text",
  "text": "What's the weather like today?"
}
```

All Agents **MUST** support text content blocks when included in prompts.

**text** `string` *required*

The text content to display

**annotations** `Annotations`

Optional metadata about how the content should be used or displayed. [Learn
more](https://modelcontextprotocol.io/specification/2025-06-18/server/resources#annotations).

### Image content&#x20;

Images can be included for visual context or analysis.

```json theme={null}
{
  "type": "image",
  "mimeType": "image/png",
  "data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB..."
}
```

&#x20;Requires the `image` [prompt
capability](https://agentclientprotocol.com/protocol/v1/initialization.md#prompt-capabilities) when included in
prompts.

**data** `string` *required*

Base64-encoded image data

**mimeType** `string` *required*

The MIME type of the image (e.g., "image/png", "image/jpeg")

**uri** `string`

Optional URI reference for the image source

**annotations** `Annotations`

Optional metadata about how the content should be used or displayed. [Learn
more](https://modelcontextprotocol.io/specification/2025-06-18/server/resources#annotations).

### Audio content&#x20;

Audio data for transcription or analysis.

```json theme={null}
{
  "type": "audio",
  "mimeType": "audio/wav",
  "data": "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAAB..."
}
```

&#x20;Requires the `audio` [prompt
capability](https://agentclientprotocol.com/protocol/v1/initialization.md#prompt-capabilities) when included in
prompts.

**data** `string` *required*

Base64-encoded audio data

**mimeType** `string` *required*

The MIME type of the audio (e.g., "audio/wav", "audio/mp3")

**annotations** `Annotations`

Optional metadata about how the content should be used or displayed. [Learn
more](https://modelcontextprotocol.io/specification/2025-06-18/server/resources#annotations).

### Embedded resource&#x20;

Complete resource contents embedded directly in the message.

```json theme={null}
{
  "type": "resource",
  "resource": {
    "uri": "file:///home/user/script.py",
    "mimeType": "text/x-python",
    "text": "def hello():\n    print('Hello, world!')"
  }
}
```

This is the preferred way to include context in prompts, such as when using @-mentions to reference files or other resources.

By embedding the content directly in the request, Clients can include context from sources that the Agent may not have direct access to.

&#x20;Requires the `embeddedContext` [prompt
capability](https://agentclientprotocol.com/protocol/v1/initialization.md#prompt-capabilities) when included in
prompts.

**resource** `EmbeddedResourceResource` *required*

The embedded resource contents, which can be either:

**Text Resource**

**uri** `string` *required*

The URI identifying the resource

**text** `string` *required*

The text content of the resource

**mimeType** `string`

Optional MIME type of the text content

**Blob Resource**

**uri** `string` *required*

The URI identifying the resource

**blob** `string` *required*

Base64-encoded binary data

**mimeType** `string`

Optional MIME type of the blob

**annotations** `Annotations`

Optional metadata about how the content should be used or displayed. [Learn
more](https://modelcontextprotocol.io/specification/2025-06-18/server/resources#annotations).

### Resource link

References to resources that the Agent can access.

All Agents **MUST** support resource links when included in prompts.

```json theme={null}
{
  "type": "resource_link",
  "uri": "file:///home/user/document.pdf",
  "name": "document.pdf",
  "mimeType": "application/pdf",
  "size": 1024000
}
```

**uri** `string` *required*

The URI of the resource

**name** `string` *required*

A human-readable name for the resource

**mimeType** `string`

The MIME type of the resource

**title** `string`

Optional display title for the resource

**description** `string`

Optional description of the resource contents

**size** `integer`

Optional size of the resource in bytes

**annotations** `Annotations`

Optional metadata about how the content should be used or displayed. [Learn
more](https://modelcontextprotocol.io/specification/2025-06-18/server/resources#annotations).


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.