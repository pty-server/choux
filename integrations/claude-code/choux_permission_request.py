#!/usr/bin/env python3
"""Route Claude Code permission requests through Choux when Ptys is available."""

import json
import os
import subprocess
import sys
from typing import Any


DEFAULT_TIMEOUT_SECONDS = 60
MAX_MESSAGE_LENGTH = 1_500
CONTENT_PREVIEW_LENGTH = 1_000


def normal_flow() -> None:
    """Leave stdout empty so Claude Code shows its usual approval dialog."""
    raise SystemExit(0)


def as_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
    except (TypeError, ValueError):
        return repr(value)


def clipped(value: str) -> str:
    if len(value) <= MAX_MESSAGE_LENGTH:
        return value
    return f"{value[:MAX_MESSAGE_LENGTH]}\n\n[truncated]"


def preview(value: str) -> str:
    if len(value) <= CONTENT_PREVIEW_LENGTH:
        return value
    return f"{value[:CONTENT_PREVIEW_LENGTH]}\n\n[preview truncated]"


def file_change_details(tool_name: object, details: object) -> list[str] | None:
    if tool_name not in ("Write", "Edit") or not isinstance(details, dict):
        return None
    file_path = details.get("file_path")
    if not isinstance(file_path, str) or not file_path:
        return None

    parts = ["", "File:", file_path]
    if tool_name == "Write":
        content = details.get("content")
        if isinstance(content, str):
            lines = content.count("\n") + (1 if content else 0)
            parts.extend(["", f"New content ({len(content)} characters, {lines} lines):", preview(content)])
        return parts

    old_string = details.get("old_string")
    new_string = details.get("new_string")
    if isinstance(old_string, str):
        parts.extend(["", f"Replace ({len(old_string)} characters):", preview(old_string)])
    if isinstance(new_string, str):
        parts.extend(["", f"With ({len(new_string)} characters):", preview(new_string)])
    return parts


def question_for(request: dict[str, Any]) -> dict[str, Any]:
    tool_name = request.get("tool_name")
    tool_input = request.get("tool_input")
    description = tool_input.get("description") if isinstance(tool_input, dict) else None
    parts = [f"Claude Code requests permission to use {tool_name or 'a tool'}." ]
    if isinstance(description, str) and description.strip():
        parts.extend(["", description.strip()])

    details = (
        {key: value for key, value in tool_input.items() if key != "description"}
        if isinstance(tool_input, dict)
        else tool_input
    )
    file_details = file_change_details(tool_name, details)
    command = details.get("command") if isinstance(details, dict) else None
    if file_details is not None:
        parts.extend(file_details)
    elif isinstance(command, str) and command.strip():
        parts.extend(["", "Command:", clipped(command.strip())])
    else:
        detail = as_text(details)
        if detail and detail not in ("null", "{}"):
            parts.extend(["", "Request:", clipped(detail)])

    return {
        "type": "choux.question",
        "data": {
            "title": "Claude Code permission request",
            "message": "\n".join(parts),
            "options": [{"id": "allow", "label": "Allow"}, {"id": "deny", "label": "Deny"}],
            "notes": False,
        },
    }


def claude_decision(behavior: str) -> None:
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": behavior}}}))


def main() -> None:
    if not os.environ.get("PTYS_EVENT_ENDPOINT"):
        normal_flow()
    try:
        request = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError):
        normal_flow()
    if not isinstance(request, dict):
        normal_flow()
    try:
        result = subprocess.run(
            ["ptys", "event", "--request", "--timeout", str(DEFAULT_TIMEOUT_SECONDS), json.dumps(question_for(request), ensure_ascii=False)],
            check=False, capture_output=True, text=True, timeout=DEFAULT_TIMEOUT_SECONDS + 2,
        )
    except (OSError, subprocess.SubprocessError):
        normal_flow()
    if result.returncode != 0:
        normal_flow()
    try:
        response = json.loads(result.stdout)
    except json.JSONDecodeError:
        normal_flow()
    if not isinstance(response, dict) or response.get("cancelled") is True:
        normal_flow()
    if response.get("answer") == "allow":
        claude_decision("allow")
    if response.get("answer") == "deny":
        claude_decision("deny")
    normal_flow()


if __name__ == "__main__":
    main()
