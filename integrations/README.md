# Choux permission integrations

These integrations forward agent permission requests to Choux through a Ptys
`choux.question` event. Select **Allow** or **Deny** in Choux to answer the
agent. If Ptys is unavailable, the dialog is cancelled, or an integration
fails, the agent falls back to its own normal permission prompt.

## Requirements

- Ptys and Choux are running, with Choux connected to the originating Ptys
  server.
- Start the agent inside a Ptys session, so `PTYS_EVENT_ENDPOINT` is set.
- `ptys` must be discoverable from the agent process. The OpenCode integration
  also checks the login shell's PATH.

When using tmux, propagate the endpoint before starting a fresh agent process:

```tmux
set -ga update-environment " PTYS_EVENT_ENDPOINT"
```

Detach and attach tmux from a Ptys session, then create a new window or pane.
Existing processes do not receive a newly added environment variable.

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

## OpenCode

Copy the global plugin and merge `opencode/opencode.json` into
`~/.config/opencode/opencode.json`:

```bash
mkdir -p ~/.config/opencode/plugins
cp integrations/opencode/choux-permission.js ~/.config/opencode/plugins/
```

The included `permission` entries make Bash and file edits ask for approval;
without them OpenCode normally allows most actions without a prompt. Restart
OpenCode after installing the plugin. The integration grants a single OpenCode
approval only; it does not create an "always allow" rule.

## Files

- `codex/` — Codex `PermissionRequest` hook and its hook configuration.
- `claude-code/` — Claude Code `PermissionRequest` hook and settings entry.
- `opencode/` — OpenCode `permission.asked` plugin and permission settings.
