#!/usr/bin/env python3
"""Route Codex permission requests through Choux when Ptys is available."""

import json
import math
import os
import subprocess
import sys
import time
from typing import Any


DEFAULT_TIMEOUT_SECONDS = 60
SUBPROCESS_GRACE_SECONDS = 2
MAX_BLOCK_LENGTH = 4_000
MAX_FIELD_LENGTH = 500

# Codex sends the canonical payload name, not the matcher alias: `apply_patch` rather
# than Write/Edit, `spawn_agent` rather than Agent.
FIELD_LABELS = (
    ("command", "Command"),
    ("path", "Path"),
    ("file_path", "File"),
    ("url", "URL"),
    ("query", "Query"),
    ("pattern", "Pattern"),
    ("task_name", "Task"),
    ("objective", "Objective"),
    ("description", "Description"),
    ("message", "Message"),
)


def normal_flow() -> None:
    """Leave stdout empty so Codex uses its usual approval prompt."""
    raise SystemExit(0)


def timeout_seconds() -> int:
    """Raising this past the Codex hook timeout only makes Codex give up first, so
    the hook configuration has to grow with it."""
    try:
        configured = int(os.environ.get("CHOUX_QUESTION_TIMEOUT_SECONDS", ""))
    except ValueError:
        return DEFAULT_TIMEOUT_SECONDS
    return configured if configured > 0 else DEFAULT_TIMEOUT_SECONDS


def tmux_endpoint() -> str | None:
    if not os.environ.get("TMUX"):
        return None
    try:
        output = subprocess.run(
            ["tmux", "show-environment", "PTYS_EVENT_ENDPOINT"],
            check=False, capture_output=True, text=True, timeout=2,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return output.split("=", 1)[1] if output.startswith("PTYS_EVENT_ENDPOINT=") else None


def endpoint_candidates() -> list[str]:
    """A tmux pane outlives the server that spawned it, so the inherited endpoint
    can point at a dead URL. Tmux tracks the live value - prefer it inside tmux."""
    ordered = [tmux_endpoint(), os.environ.get("PTYS_EVENT_ENDPOINT")]
    return list(dict.fromkeys(value for value in ordered if value))


def as_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
    except (TypeError, ValueError):
        return repr(value)


def clipped(value: str, limit: int = MAX_BLOCK_LENGTH) -> str:
    if len(value) <= limit:
        return value
    return f"{value[:limit]}\n\n[truncated]"


def allow_option() -> dict[str, Any]:
    return {"id": "allow", "label": "Allow"}


def deny_option() -> dict[str, Any]:
    return {"id": "deny", "label": "Deny", "description": "A note becomes the reason Codex is given"}


def question(title: str, message: str, blocks: list[dict[str, Any]]) -> dict[str, Any]:
    """Codex accepts only a one-shot allow or deny from this hook, so no persistent
    "don't ask again" option may be offered here."""
    return {
        "type": "choux.question",
        "data": {
            "title": title,
            "message": message,
            "options": [allow_option(), deny_option()],
            "notes": True,
            **({"blocks": blocks} if blocks else {}),
        },
    }


def command_question(command: str) -> dict[str, Any]:
    """Codex reports the turn's `cwd`, which need not be the command's effective
    workdir, so the block carries no working directory."""
    return question(
        "Run a command",
        "Codex wants to run a command.",
        [{"kind": "command", "command": clipped(command)}],
    )


def patch_sections(patch: str) -> list[dict[str, Any]]:
    """Split Codex's apply_patch envelope into file sections without applying it."""
    headers = (
        ("*** Update File: ", "update"),
        ("*** Add File: ", "add"),
        ("*** Delete File: ", "delete"),
    )
    sections: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for line in patch.splitlines():
        matched = next(((prefix, action) for prefix, action in headers if line.startswith(prefix)), None)
        if matched is not None:
            if current is not None:
                sections.append(current)
            prefix, action = matched
            current = {"action": action, "path": line[len(prefix):].strip(), "lines": []}
        elif current is not None and line.startswith("*** Move to: "):
            current["move_to"] = line.removeprefix("*** Move to: ").strip()
        elif current is not None and line == "*** End Patch":
            sections.append(current)
            current = None
        elif current is not None and line == "*** End of File":
            continue
        elif current is not None:
            current["lines"].append(line)
    if current is not None:
        sections.append(current)
    return sections


def diff_sides(lines: list[str], action: str) -> tuple[str, str]:
    before: list[str] = []
    after: list[str] = []
    for line in lines:
        if line.startswith("@@"):
            if before or after:
                before.append("⋯")
                after.append("⋯")
        elif line.startswith("+"):
            after.append(line[1:])
        elif line.startswith("-"):
            before.append(line[1:])
        elif line.startswith(" "):
            before.append(line[1:])
            after.append(line[1:])
        elif action == "add":
            after.append(line)
        elif action == "delete":
            before.append(line)
    return clipped("\n".join(before)), clipped("\n".join(after))


def patch_blocks(patch: str) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    for section in patch_sections(patch):
        path = section.get("move_to") or section["path"]
        before, after = diff_sides(section["lines"], section["action"])
        if before or after:
            block: dict[str, Any] = {"kind": "diff", "path": path, "before": before, "after": after}
            if section.get("move_to"):
                block["badges"] = [f"moved from {section['path']}"]
            blocks.append(block)
        elif section["action"] == "delete" and section["path"]:
            blocks.append({
                "kind": "fields",
                "title": "Delete a file",
                "fields": [{"label": "File", "value": section["path"]}],
            })
    return blocks


def patch_question(patch: str) -> dict[str, Any]:
    blocks = patch_blocks(patch)
    return question(
        "Apply a patch",
        "Codex wants to change files.",
        blocks or [{"kind": "command", "command": clipped(patch), "badges": ["patch"]}],
    )


def listed_fields(tool_input: dict[str, Any]) -> list[dict[str, str]]:
    return [
        {"label": label, "value": clipped(tool_input[key].strip(), MAX_FIELD_LENGTH)}
        for key, label in FIELD_LABELS
        if isinstance(tool_input.get(key), str) and tool_input[key].strip()
    ]


def generic_question(tool_name: object, tool_input: object) -> dict[str, Any]:
    title = "Codex permission request"
    message = f"Codex requests permission to use {tool_name or 'a tool'}."
    fields = listed_fields(tool_input) if isinstance(tool_input, dict) else []
    if fields:
        return question(title, message, [{"kind": "fields", "fields": fields}])

    detail = as_text(tool_input)
    if not detail or detail in ("null", "{}"):
        return question(title, message, [])
    return question(title, "\n".join([message, "", "Request:", clipped(detail)]), [])


def origin_for(request: dict[str, Any]) -> dict[str, Any]:
    """Codex's PermissionRequest carries no tool-use id, so none is invented here.
    The session id alone still lets Choux withdraw the question when the run ends."""
    origin: dict[str, Any] = {"agent": "codex"}
    for key, value in (
        ("agentSessionId", request.get("session_id")),
        ("tool", request.get("tool_name")),
    ):
        if isinstance(value, str) and value:
            origin[key] = value
    return origin


def question_for(request: dict[str, Any]) -> dict[str, Any]:
    tool_name = request.get("tool_name")
    tool_input = request.get("tool_input")
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    usable = isinstance(command, str) and command.strip()

    if tool_name == "apply_patch" and usable:
        built = patch_question(command.strip())
    elif tool_name == "Bash" and usable:
        built = command_question(command.strip())
    else:
        built = generic_question(tool_name, tool_input)
    built["data"]["origin"] = origin_for(request)
    return built


def codex_decision(decision: dict[str, Any]) -> None:
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}}))
    raise SystemExit(0)


def decide(stdout: str) -> None:
    """`ptys event --request` prints the reply event's `data`, not the whole envelope.
    Anything but the exact `allow` answer leaves Codex to approve the request itself."""
    try:
        response = json.loads(stdout)
    except json.JSONDecodeError:
        return
    if not isinstance(response, dict) or response.get("cancelled") is True:
        return
    answer = response.get("answer")
    note = response.get("note")
    if answer == "allow":
        codex_decision({"behavior": "allow"})
    if answer == "deny":
        codex_decision({"behavior": "deny", **({"message": note} if isinstance(note, str) and note.strip() else {})})


def ask(payload: dict[str, Any], endpoint: str, timeout: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["ptys", "event", "--request", "--timeout", str(timeout), json.dumps(payload, ensure_ascii=False)],
        check=False, capture_output=True, text=True, timeout=timeout + SUBPROCESS_GRACE_SECONDS,
        env={**os.environ, "PTYS_EVENT_ENDPOINT": endpoint},
    )


def main() -> None:
    candidates = endpoint_candidates()
    if not candidates:
        normal_flow()
    try:
        request = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError):
        normal_flow()
    if not isinstance(request, dict):
        normal_flow()
    payload = question_for(request)

    # A dead endpoint fails fast, but the budget is shared so two attempts can never
    # outlast the hook timeout Codex is holding open for this process.
    deadline = time.monotonic() + timeout_seconds()
    for endpoint in candidates:
        # Rounded up: flooring spent the whole budget of a one-second timeout before
        # the first attempt, and silently shaved a second off every longer one.
        remaining = math.ceil(deadline - time.monotonic())
        if remaining < 1:
            break
        try:
            result = ask(payload, endpoint, remaining)
        except (OSError, subprocess.SubprocessError):
            continue
        if result.returncode != 0:
            continue
        decide(result.stdout)
        break
    normal_flow()


if __name__ == "__main__":
    main()
