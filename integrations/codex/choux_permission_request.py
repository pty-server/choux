#!/usr/bin/env python3
"""Route Codex permission requests through Choux when Ptys is available."""

import json
import os
import subprocess
import sys
from typing import Any


DEFAULT_TIMEOUT_SECONDS = 60
MAX_MESSAGE_LENGTH = 4_000


def normal_flow() -> None:
    """Leave stdout empty so Codex uses its usual approval prompt."""
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


def question_for(request: dict[str, Any]) -> dict[str, Any]:
    tool_name = request.get("tool_name")
    tool_input = request.get("tool_input")
    description = tool_input.get("description") if isinstance(tool_input, dict) else None
    parts = [f"Codex requests permission to use {tool_name or 'a tool'}." ]
    if isinstance(description, str) and description.strip():
        parts.extend(["", description.strip()])

    details = (
        {key: value for key, value in tool_input.items() if key != "description"}
        if isinstance(tool_input, dict)
        else tool_input
    )
    command = details.get("command") if isinstance(details, dict) else None
    if isinstance(command, str) and command.strip():
        label = "Patch" if tool_name == "apply_patch" else "Command"
        parts.extend(["", f"{label}:", clipped(command.strip())])
    else:
        detail = as_text(details)
        if detail and detail not in ("null", "{}"):
            parts.extend(["", "Request:", clipped(detail)])
    return {
        "type": "choux.question",
        "data": {
            "title": "Codex permission request",
            "message": "\n".join(parts),
            "options": [
                {"id": "allow", "label": "Allow"},
                {"id": "deny", "label": "Deny"},
            ],
            "notes": False,
        },
    }


def codex_decision(behavior: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": {"behavior": behavior},
        },
    }))


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
            [
                "ptys", "event", "--request", "--timeout",
                str(DEFAULT_TIMEOUT_SECONDS), json.dumps(question_for(request), ensure_ascii=False),
            ],
            check=False, capture_output=True, text=True,
            timeout=DEFAULT_TIMEOUT_SECONDS + 2,
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
        codex_decision("allow")
    if response.get("answer") == "deny":
        codex_decision("deny")
    normal_flow()


if __name__ == "__main__":
    main()
