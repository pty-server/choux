# Choux agent integrations

These integrations forward agent permission requests to Choux through a Ptys
`choux.question` event. Answer it in Choux to answer the agent. If Ptys is
unavailable, the dialog is cancelled, or an integration fails, the agent falls
back to its own normal permission prompt.

Claude Code and OpenCode each have a second, optional integration that reports
what the agent is doing as a `choux.agent.state` event, so Choux can show a live
status next to the right session - and, in tmux, next to the right window.

## Requirements

- Ptys and Choux are running, with Choux connected to the originating Ptys
  server.
- Start the agent inside a Ptys session, so `PTYS_EVENT_ENDPOINT` is set.
- `ptys` must be discoverable from the agent process. The OpenCode permission
  plugin also checks the login shell's PATH, because OpenCode can inherit a PATH
  that the terminal only extends once its login shell starts.

When using tmux, propagate the endpoint before starting a fresh agent process:

```tmux
set -ga update-environment " PTYS_EVENT_ENDPOINT"
```

Detach and attach tmux from a Ptys session, then create a new window or pane.
Existing processes do not receive a newly added environment variable.

`update-environment` also keeps the tmux-tracked value current after a server
restart. All three integrations read it in preference to their own environment,
because a pane outlives the server that spawned it and keeps a token that is no
longer valid. Without the setting the tmux value is as stale as the inherited
one, so it is load-bearing for panes that are already running, not only for
fresh ones.

A stale token is rejected by the server rather than reported as an error, so
nothing appears in Choux and nothing is written anywhere. To check an endpoint:

```bash
curl -si -X POST "$PTYS_EVENT_ENDPOINT" \
  -H 'content-type: application/json' \
  -d '{"type":"choux.agent.state","data":{"agent":"probe"},"request":false}' | head -1
```

`202` means the token is live; `401 unauthorized` means it is stale. Running
`ptys event-listener` while the agent uses a tool is the other check - a healthy
install emits `choux.agent.state` events.

## Codex

Copy the script and merge the contents of `codex/hooks.json` into
`~/.codex/hooks.json`:

```bash
mkdir -p ~/.codex/hooks
cp integrations/codex/choux_permission_request.py ~/.codex/hooks/
```

The command in the hook configuration assumes this destination. Start a new
Codex session after installing it and enable/trust the hook if Codex asks.

## Claude Code

Copy the script and merge `claude-code/settings.json` into the `hooks` object
in `~/.claude/settings.json`:

```bash
mkdir -p ~/.claude/hooks
cp integrations/claude-code/choux_permission_request.py ~/.claude/hooks/
```

Start a new Claude Code session. Its `PermissionRequest` hook runs only when
Claude Code is about to display a native permission dialog.

A `Bash` request is sent as a `command` block, so Choux shows the command in a
monospace panel with its working directory and a badge when the sandbox is off.
`Read` and `WebFetch` are sent as a `fields` block - path and line range, URL
and what is being asked of it. `Edit` and `Write` are sent as a `diff` block:
`Edit` diffs its replaced text against the replacement, `Write` shows its
content as entirely new. Long content is previewed, not sent whole. Every other
tool keeps the plain text rendering.

Answers keep Claude Code's own yes/no wording rather than an allow/deny one of
their own. Beyond **Yes** and **No**, the dialog offers whatever Claude Code
suggested in the request's `permission_suggestions` - the same extra choices its
native prompt would show. An `addRules` suggestion becomes **Yes, don't ask
again**, described with the rules it writes and where (`Adds Bash(git commit *)
for this project`); a `setMode` suggestion becomes **Yes, all edits for this
session**. The chosen suggestion is returned verbatim as `updatedPermissions`,
so a compound command is covered per segment rather than by a prefix guessed
here. Identical suggestions - Claude repeats a group per segment - collapse into
one option. A request without suggestions simply offers yes and no.

A note left on **No** is passed back as the reason Claude Code is given.

Claude Code keeps its own approval open next to this one - the IDE integration
shows a diff for `Edit` and `Write` - and it does not stop the hook when that
one is answered, so the hook would sit on a dead request for its full minute.
The question therefore carries `origin.agentSessionId` and `origin.toolUseId`,
and the state reporter sends both. When Claude Code reports that same tool call
finished, or that the run ended, Choux answers the question as cancelled and the
hook exits at once. Matching the tool call rather than the run keeps questions
from a parallel tool batch queued - each stays until it is answered. Install both
integrations to get that; the permission hook alone still works, but a request
approved in the IDE leaves its Choux dialog up until the timeout.

### Agent status

To also show Claude Code's activity in Choux's session list, install the state
reporter and merge `claude-code/agent-state.settings.json` the same way:

```bash
cp integrations/claude-code/choux_agent_state.py ~/.claude/hooks/
```

It is wired to every Claude Code hook event, so it runs on every tool call. It
posts directly to the Ptys control socket - no `ptys` process per event - and
always exits 0 without writing to stdout, so it cannot disturb the agent.

Both files carry a `PermissionRequest` entry. When merging them into
`~/.claude/settings.json`, keep both commands in that event's `hooks` array
rather than letting one replace the other.

Inside tmux the reporter tags each event with `$TMUX_PANE`, which is what lets
Choux attribute status to a single window instead of the whole session. Panes
that started before `update-environment` was set have no endpoint and report
nothing - see the requirements above.

Like the permission hook, it prefers the tmux-tracked endpoint over its own
environment and falls back to the inherited one, treating any non-2xx answer as
a failed delivery.

## OpenCode

Copy the global plugin and merge `opencode/opencode.json` into
`~/.config/opencode/opencode.json`:

```bash
mkdir -p ~/.config/opencode/plugins
cp integrations/opencode/choux-permission.js ~/.config/opencode/plugins/
```

The included `permission` entries make Bash and file edits ask for approval;
without them OpenCode normally allows most actions without a prompt. Restart
OpenCode after installing the plugin.

A `bash` request is sent as a `command` block, so Choux shows the command in a
monospace panel with the project directory. An `edit` request is sent as a
`diff` block - OpenCode describes the change as a unified patch, which the
plugin splits back into the two sides the dialog diffs. `read`, `webfetch`,
`task` and `external_directory` are sent as a `fields` block. Every other
permission keeps the plain text rendering.

Beyond **Yes** and **No**, the dialog offers **Yes, don't ask again** whenever
OpenCode says the request can be remembered - it answers `always`, which is
OpenCode's own persistent approval, so the rule it writes is the one OpenCode
would have written itself. **Yes** grants a single approval only.

A note left on **No** is passed back as the reason OpenCode is given.

### Agent status

To also show OpenCode's activity in Choux's session list, install the state
reporter plugin as well:

```bash
cp integrations/opencode/choux-agent-state.js ~/.config/opencode/plugins/
```

It reports every prompt, tool call, permission request and idle turn, mapped
onto the same event names the Claude Code reporter sends, so the session list
and the tmux window list treat both agents alike. Like that reporter it posts
directly to the Ptys control socket - no `ptys` process per event - prefers the
tmux-tracked endpoint, tags each event with `$TMUX_PANE`, and swallows its own
failures so it cannot disturb the agent.

OpenCode keeps its own approval open next to this one, and answering there does
not stop the plugin waiting on ours. The question therefore carries
`origin.agentSessionId` and `origin.toolUseId`, and the state reporter sends
both, so a request answered in OpenCode withdraws its Choux dialog at once.
Install both plugins to get that; the permission plugin alone still works, but a
request approved in OpenCode leaves its Choux dialog up until the timeout.

## Files

- `codex/` — Codex `PermissionRequest` hook and its hook configuration.
- `claude-code/` — Claude Code `PermissionRequest` hook and settings entry,
  plus the optional `choux.agent.state` reporter and its settings entry.
- `opencode/` — OpenCode `permission.asked` plugin and permission settings,
  plus the optional `choux.agent.state` reporter plugin.
