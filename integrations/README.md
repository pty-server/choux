# Choux agent integrations

These integrations forward agent permission requests to Choux through a Ptys
`choux.question` event. Answer it in Choux to answer the agent. If Ptys is
unavailable, the dialog is cancelled, or an integration fails, the agent falls
back to its own normal permission prompt.

Each agent also reports what it is doing as a `choux.agent.state` event, so Choux
can show a live status next to the right session - and, in tmux, next to the right
window. Claude Code's plugin carries both halves; for Codex and OpenCode the
reporter is a second, optional install.

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

Copy both scripts and merge the contents of `codex/hooks.json` into
`~/.codex/hooks.json`:

```bash
mkdir -p ~/.codex/hooks
cp integrations/codex/choux_permission_request.py ~/.codex/hooks/
cp integrations/codex/choux_agent_state.py ~/.codex/hooks/
```

The commands in the hook configuration assume this destination. Merge rather than
replace: keep any unrelated hooks you already have, and where `PermissionRequest`
already exists keep both Choux handlers in that group's `hooks` array. Codex
launches every matching command hook for an event concurrently, so their order in
that array decides nothing - what matters is that both are there. The reporter
posts the waiting state while the bridge sits on the question, and returns no
decision of its own, so it cannot affect the outcome. Start a new Codex session
afterwards and enable/trust the hooks if Codex asks.

Upgrading from an earlier copy of this integration means recopying
`choux_permission_request.py`. An installed script that emits `ptys.question`
rather than `choux.question` predates the rename and Choux ignores it.

A `Bash` request is sent as a `command` block. For `apply_patch`, the bridge
splits Codex's patch envelope by file and converts each change to the same native
`diff` block used by the Claude Code integration. New and updated files therefore
use Choux's inline diff display; delete-only sections use a labelled file field,
and an unrecognised patch falls back to a clipped raw preview. The command block
does not claim a working directory - Codex reports the turn's `cwd`, which is not
necessarily where the command runs. Every other tool, including MCP and extension
tools under their own canonical names, is sent as a `fields` block built from an
allowlist of useful arguments, falling back to a clipped preview. A note left on
**Deny** becomes the reason Codex is given.

The dialog offers **Allow** and **Deny** only. Codex's `PermissionRequest` hook
accepts nothing else - a persistent rule or a changed permission mode would be
rejected outright - so there is deliberately no "don't ask again" here.

The question carries `origin.agentSessionId`, so ending the Codex run withdraws
anything it left waiting. It carries no `origin.toolUseId`: Codex's permission
payload has no tool-call identifier, and a fabricated one would withdraw the
wrong question. A Codex question therefore stays up until it is answered, the run
ends, or the request times out.

The bridge waits 60 seconds for an answer, under the 65-second hook timeout.
`CHOUX_QUESTION_TIMEOUT_SECONDS` overrides that; raise the hook's own `timeout`
alongside it, or Codex gives up first.

### Agent status

`choux_agent_state.py` is wired to every Codex lifecycle hook, so Choux shows the
run as idle, working, waiting, compacting, or on a named tool, and counts its
subagents. It posts directly to the Ptys control socket - no `ptys` process per
event - and always exits 0 without writing to stdout, so it cannot disturb Codex.

Codex does not emit `PreToolUse`/`PostToolUse` for every internal tool, so the
coarse working/idle state comes from `UserPromptSubmit` and `Stop`; tool events
sharpen it when they arrive. There is also no failed-tool event, so a tool that
fails can stay on screen until the next lifecycle event or the stale-state sweep.

Inside tmux the reporter tags each event with `$TMUX_PANE`, which is what lets
Choux attribute status to a single window instead of the whole session.

## Claude Code

Install the plugin from this repository's marketplace:

```bash
claude plugin marketplace add pty-server/choux
claude plugin install choux@pty-server
```

That wires the permission bridge and the agent status reporter together, without
touching the `hooks` object in `~/.claude/settings.json`. Start a new Claude Code
session afterwards. There is no version to bump and no script to recopy: the
marketplace tracks this repository, so an updated hook arrives on its own.
`claude plugin list` shows what is installed, and `claude plugin uninstall
choux@pty-server` removes it.

Upgrading from the manual install means removing it. The old copy and the plugin
both fire otherwise, and one permission request opens two Choux dialogs:

```bash
rm -f ~/.claude/hooks/choux_permission_request.py ~/.claude/hooks/choux_agent_state.py
```

Then delete the `choux_*` entries from the `hooks` object in
`~/.claude/settings.json`.

The `PermissionRequest` hook runs only when Claude Code is about to display a
native permission dialog.

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
from a parallel tool batch queued - each stays until it is answered. The plugin
installs the reporter alongside the bridge, which is what makes that work.

### Agent status

`choux_agent_state.py` is wired to every Claude Code hook event, so it runs on
every tool call and Choux can show a live status next to the right session. It
posts directly to the Ptys control socket - no `ptys` process per event - and
always exits 0 without writing to stdout, so it cannot disturb the agent.

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

- `codex/` — Codex `PermissionRequest` hook, the `choux.agent.state` reporter,
  their hook configuration, and the tests covering both scripts.
- `claude-code/` — the Claude Code plugin: its manifest, the hook configuration
  wiring both scripts, and the `PermissionRequest` bridge and `choux.agent.state`
  reporter themselves under `scripts/`. Published through
  `.claude-plugin/marketplace.json` at the repository root.
- `opencode/` — OpenCode `permission.asked` plugin and permission settings,
  plus the optional `choux.agent.state` reporter plugin.
