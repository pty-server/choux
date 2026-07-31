# Supported custom events

Choux listens for selected request events sent by applications running inside a Ptys session. Ptys injects `PTYS_EVENT_ENDPOINT` into each session; applications send an event to that endpoint and receive the user's response from the same HTTP request.

## `choux.question`

Use `choux.question` to ask the user to choose an option. Choux presents it immediately in a global dialog, even when the originating session is not focused.

The event must be a Ptys request event (`request: true`). Its `data` is:

```json
{
  "title": "Optional short title",
  "message": "May the agent modify package.json?",
  "options": [
    { "id": "allow-once", "label": "Allow once" },
    { "id": "deny", "label": "Deny", "description": "Do not change any files" }
  ],
  "notes": true,
  "blocks": [
    { "kind": "command", "command": "npm test -- --run", "cwd": "/home/you/project", "badges": ["sandbox disabled"] }
  ]
}
```

`message` must be non-empty. Include at least one option, and give every option a unique, non-empty `id` and `label`. `title` and `description` are optional. Choux renders all fields as plain text.

### Blocks

`blocks` is optional structured detail, drawn between the message and the
options. Use it instead of pasting the same content into `message` - Choux gives
each block its own presentation.

| `kind` | Fields | Shown as |
| --- | --- | --- |
| `command` | `command` (required), `cwd`, `badges` | The command in a monospace panel, with the working directory and any badges in its header |

Keep `message` a one-line summary when you send blocks; it is the sentence above
the panel, not a second copy of the payload.

A block whose `kind` this Choux build does not know, or that is missing its
required field, is dropped - the rest of the question is still shown. A sender
may therefore emit newer block kinds without checking the client version, but
must keep `message` meaningful on its own.

### Withdrawing a question the sender no longer needs

An agent may offer the same choice in two places at once - Claude Code shows a
diff in its IDE while its hook asks here. Whichever one is answered, the other
must stop waiting, and the sending process cannot always say so itself.

Send `origin` with the question to let Choux resolve that:

```json
{ "agent": "claude-code", "agentSessionId": "0f3c…", "tool": "Write" }
```

`agent` is required, the rest optional. When a `choux.agent.state` event carries
the same `agentSessionId` and reports anything other than waiting for approval,
Choux answers the matching questions with `{ "cancelled": true }` and closes the
dialog: an agent that has moved on already got its answer elsewhere. Questions
without an `origin`, and those from other agent runs, are untouched.

`notes` controls the free-text note field. Send `false` to present the options alone, for a request where a note has nowhere to go. It defaults to `true`, so a request that omits it still offers the note.

### Send with the Ptys CLI

From a command running inside a Ptys session:

```bash
ptys event --request --timeout 60 '{
  "type": "choux.question",
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

`--timeout` is in seconds. Use `--timeout 0` to wait indefinitely. Ptys prints the reply event envelope as JSON. A finite timeout arrives as the request's `ttl`, and the dialog counts it down; an unlimited request shows no countdown.

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
  "type": "choux.question.answer",
  "data": { "answer": "allow-once", "note": "Only for this change" }
}
```

`note` is optional and is supplied by the user. A request sent with `"notes": false` never carries one. Cancellation returns:

```json
{
  "sessionId": "the-originating-session",
  "type": "choux.question.answer",
  "data": { "cancelled": true, "note": "Ask again after tests pass" }
}
```

Check `data.cancelled === true` before reading `data.answer`.

Choux can be configured not to handle questions at all (Settings → Events →
"Handle question requests"). It then replies `{ "cancelled": true }` straight
away rather than staying silent, so senders are never left waiting on their
timeout. Always keep a local fallback for a cancelled reply.

The other two settings in that group decide what a question does to the app
window: "Bring Choux to the front" reveals and focuses it (on by default), and
"Follow sessions asking for input" additionally selects the session and
switches to its tmux window (off by default). Both also apply to an agent
reporting `waiting` through `choux.agent.state` below.

Choux's WebSocket reply contains only the reply `type` and `data`; Ptys restores the originating `sessionId` before returning this envelope to the application.

Ptys returns `409` if no event subscriber is connected or the session ends, and `504` if a finite request times out. When multiple clients are connected, Ptys accepts the first reply.

## `choux.agent.state`

Use `choux.agent.state` to report what an agent in the session is doing. Choux
shows it next to the session in the sidebar, and next to the individual tmux
window when the event carries a pane.

Unlike `choux.question`, this is a plain notification - send it **without**
`--request`. Ptys accepts it whether or not a client is listening, so a
reporting hook is safe to run when Choux is closed.

```json
{
  "agent": "claude-code",
  "event": "PreToolUse",
  "at": 1785510777123,
  "pane": "%3",
  "pid": 302457,
  "cwd": "/home/you/project",
  "agentSessionId": "0f3c…",
  "tool": "Bash",
  "detail": "npm test",
  "message": "Claude needs your permission to use Bash"
}
```

`agent`, `event` and `at` (epoch milliseconds) are required; everything else is
optional. `at` also orders events - hooks are separate processes, so a payload
older than the state Choux already holds is dropped.

`pane` is the tmux pane id (`$TMUX_PANE`). One Ptys session hosting a tmux
client covers every window in that client, so without a pane Choux can only
attribute the state to the whole session. Pass it whenever the reporter knows
it.

Choux understands these Claude Code `event` names and ignores any other:

| `event` | Shown as |
| --- | --- |
| `SessionStart` | Idle |
| `UserPromptSubmit`, `PostToolUse` | Working |
| `PreToolUse` | the `tool` name; `Task` also counts a subagent |
| `PermissionRequest`, `Notification` | Awaiting approval |
| `SubagentStop` | one fewer subagent |
| `PreCompact` | Compacting |
| `Stop` | Idle |
| `SessionEnd` | the entry is dropped |

Keep `detail` short - it is a one-line hint, not a payload. Do not send file
contents or diffs.

State that stops being refreshed expires after ten minutes. Choux also drops
state for a pane once tmux no longer lists it, and for a session once that
session exits, so an agent that is killed without reporting `SessionEnd` still
disappears.

`ptys` supplies `sessionId`; sending your own is an error.
