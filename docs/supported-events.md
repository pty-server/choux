# Supported custom events

Choux listens for selected request events sent by applications running inside a Ptys session. Ptys injects `PTYS_EVENT_ENDPOINT` into each session; applications send an event to that endpoint and receive the user's response from the same HTTP request.

## `ptys.question`

Use `ptys.question` to ask the user to choose an option. Choux presents it immediately in a global dialog, even when the originating session is not focused.

The event must be a Ptys request event (`request: true`). Its `data` is:

```json
{
  "title": "Optional short title",
  "message": "May the agent modify package.json?",
  "options": [
    { "id": "allow-once", "label": "Allow once" },
    { "id": "deny", "label": "Deny", "description": "Do not change any files" }
  ]
}
```

`message` must be non-empty. Include at least one option, and give every option a unique, non-empty `id` and `label`. `title` and `description` are optional. Choux renders all fields as plain text.

### Send with the Ptys CLI

From a command running inside a Ptys session:

```bash
ptys event --request --timeout 60 '{
  "type": "ptys.question",
  "data": {
    "title": "Permission needed",
    "message": "May the agent modify package.json?",
    "options": [
      { "id": "allow-once", "label": "Allow once" },
      { "id": "deny", "label": "Deny" }
    ]
  }
}'
```

`--timeout` is in seconds. Use `--timeout 0` to wait indefinitely. Ptys prints the reply event envelope as JSON.

### Send with `PTYS_EVENT_ENDPOINT`

On Unix, Ptys normally sets this to `http+unix:<socket>:/v1/events`.
That is a control-socket address, not a URL accepted by browser `fetch` or
`new URL`. Use `ptys event` (shown above), or an HTTP client that supports
Unix sockets and this address format. Do not send the endpoint to `fetch`.

Applications set `timeoutSeconds`; they do not send `ttl`. Ptys includes `ttl` only on the WebSocket request frame sent to clients. It is `0` for an unlimited request.

### Read the response

A selected option returns:

```json
{
  "sessionId": "the-originating-session",
  "type": "ptys.question.answer",
  "data": { "answer": "allow-once", "note": "Only for this change" }
}
```

`note` is optional and is supplied by the user. Cancellation returns:

```json
{
  "sessionId": "the-originating-session",
  "type": "ptys.question.answer",
  "data": { "cancelled": true, "note": "Ask again after tests pass" }
}
```

Check `data.cancelled === true` before reading `data.answer`.

Choux's WebSocket reply contains only the reply `type` and `data`; Ptys restores the originating `sessionId` before returning this envelope to the application.

Ptys returns `409` if no event subscriber is connected or the session ends, and `504` if a finite request times out. When multiple clients are connected, Ptys accepts the first reply.
