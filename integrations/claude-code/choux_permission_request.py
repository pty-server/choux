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
SCOPES = {
    "localSettings": " for this project",
    "projectSettings": " for this project",
    "userSettings": " for every project",
    "session": " for this session",
    "cliArg": " for this run",
}


def normal_flow() -> None:
    """Leave stdout empty so Claude Code shows its usual approval dialog."""
    raise SystemExit(0)


def event_endpoint() -> str:
    """A tmux pane outlives the server that spawned it, so the inherited endpoint
    can point at a dead URL. Tmux tracks the live value - prefer it inside tmux."""
    if os.environ.get("TMUX"):
        try:
            output = subprocess.run(
                ["tmux", "show-environment", "PTYS_EVENT_ENDPOINT"],
                check=False, capture_output=True, text=True, timeout=2,
            ).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            output = ""
        if output.startswith("PTYS_EVENT_ENDPOINT="):
            return output.split("=", 1)[1]
    return os.environ.get("PTYS_EVENT_ENDPOINT", "")


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


def rules_summary(update: dict[str, Any]) -> str | None:
    labels = [
        f"{rule.get('toolName')}({rule.get('ruleContent')})" if rule.get("ruleContent") else str(rule.get("toolName"))
        for rule in update.get("rules", [])
        if isinstance(rule, dict) and isinstance(rule.get("toolName"), str)
    ]
    return None if not labels else ", ".join(labels)


def suggestion_option(update: dict[str, Any], option_id: str) -> dict[str, Any] | None:
    scope = SCOPES.get(update.get("destination"), "")
    if update.get("type") == "addRules":
        summary = rules_summary(update)
        if summary is None:
            return None
        return {"id": option_id, "label": "Yes, don't ask again", "description": clipped(f"Adds {summary}{scope}")}
    if update.get("type") == "setMode" and isinstance(update.get("mode"), str):
        mode = update["mode"]
        label = "Yes, all edits" if mode == "acceptEdits" else f"Yes, switch to {mode}"
        return {"id": option_id, "label": f"{label}{scope}", "description": "Later requests of this kind are not asked about"}
    return None


def suggested_options(request: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, list[dict[str, Any]]]]:
    """Claude Code's own permission suggestions, already shaped like `updatedPermissions`.
    They split compound commands per segment, so they beat anything derived here."""
    suggestions = request.get("permission_suggestions")
    if not isinstance(suggestions, list):
        return [], {}

    options: list[dict[str, Any]] = []
    updates: dict[str, list[dict[str, Any]]] = {}
    seen: dict[tuple[str, str], str] = {}
    for index, update in enumerate(suggestions):
        if not isinstance(update, dict):
            continue
        option = suggestion_option(update, f"suggestion-{index}")
        if option is None:
            continue
        # Claude Code repeats a group per command segment; one option applies them all.
        key = (option["label"], option["description"])
        if key in seen:
            updates[seen[key]].append(update)
            continue
        seen[key] = option["id"]
        options.append(option)
        updates[option["id"]] = [update]
    return options, updates


def origin_for(request: dict[str, Any]) -> dict[str, Any]:
    """Lets Choux withdraw the question when this same Claude Code run reports it
    moved on - the request was answered in its IDE dialog instead."""
    origin: dict[str, Any] = {"agent": "claude-code"}
    for key, value in (("agentSessionId", request.get("session_id")), ("tool", request.get("tool_name"))):
        if isinstance(value, str) and value:
            origin[key] = value
    return origin


def allow_option() -> dict[str, Any]:
    return {"id": "allow", "label": "Yes"}


def deny_option() -> dict[str, Any]:
    return {"id": "deny", "label": "No", "description": "A note becomes the reason Claude Code is given"}


def command_question(command: str, description: str | None, tool_input: dict[str, Any], cwd: object, suggestions: list[dict[str, Any]]) -> dict[str, Any]:
    options = [allow_option(), *suggestions, deny_option()]

    block: dict[str, Any] = {"kind": "command", "command": clipped(command)}
    if isinstance(cwd, str) and cwd:
        block["cwd"] = cwd
    if tool_input.get("dangerouslyDisableSandbox") is True:
        block["badges"] = ["sandbox disabled"]

    return {
        "type": "choux.question",
        "data": {
            "title": "Run a command",
            "message": description or "Claude Code wants to run a command.",
            "options": options,
            "blocks": [block],
        },
    }


def fields_question(title: str, message: str, fields: list[tuple[str, object]], suggestions: list[dict[str, Any]]) -> dict[str, Any]:
    listed = [{"label": label, "value": clipped(value.strip())} for label, value in fields if isinstance(value, str) and value.strip()]
    return {
        "type": "choux.question",
        "data": {
            "title": title,
            "message": message,
            "options": [allow_option(), *suggestions, deny_option()],
            "blocks": [{"kind": "fields", "fields": listed}],
        },
    }


def line_range(tool_input: dict[str, Any]) -> str | None:
    offset = tool_input.get("offset")
    limit = tool_input.get("limit")
    start = offset if isinstance(offset, int) and offset > 0 else 1
    if not isinstance(limit, int) or limit <= 0:
        return None if start == 1 else f"from line {start}"
    return f"lines {start}-{start + limit - 1}"


def read_question(tool_input: dict[str, Any], suggestions: list[dict[str, Any]]) -> dict[str, Any]:
    return fields_question(
        "Read a file",
        "Claude Code wants to read a file.",
        [("File", tool_input.get("file_path")), ("Range", line_range(tool_input)), ("Pages", tool_input.get("pages"))],
        suggestions,
    )


def fetch_question(tool_input: dict[str, Any], suggestions: list[dict[str, Any]]) -> dict[str, Any]:
    return fields_question(
        "Fetch a web page",
        "Claude Code wants to fetch a URL.",
        [("URL", tool_input.get("url")), ("Asking", tool_input.get("prompt"))],
        suggestions,
    )


def generic_question(tool_name: object, description: str | None, details: object, suggestions: list[dict[str, Any]]) -> dict[str, Any]:
    parts = [f"Claude Code requests permission to use {tool_name or 'a tool'}."]
    if description:
        parts.extend(["", description])

    file_details = file_change_details(tool_name, details)
    if file_details is not None:
        parts.extend(file_details)
    else:
        detail = as_text(details)
        if detail and detail not in ("null", "{}"):
            parts.extend(["", "Request:", clipped(detail)])

    return {
        "type": "choux.question",
        "data": {
            "title": "Claude Code permission request",
            "message": "\n".join(parts),
            "options": [allow_option(), *suggestions, deny_option()],
        },
    }


def question_for(request: dict[str, Any]) -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]]]:
    tool_name = request.get("tool_name")
    tool_input = request.get("tool_input")
    raw_description = tool_input.get("description") if isinstance(tool_input, dict) else None
    description = raw_description.strip() if isinstance(raw_description, str) and raw_description.strip() else None
    suggestions, updates = suggested_options(request)

    details = (
        {key: value for key, value in tool_input.items() if key != "description"}
        if isinstance(tool_input, dict)
        else tool_input
    )
    command = details.get("command") if isinstance(details, dict) else None
    if not isinstance(tool_input, dict):
        question = generic_question(tool_name, description, details, suggestions)
    elif tool_name == "Bash" and isinstance(command, str) and command.strip():
        question = command_question(command.strip(), description, tool_input, request.get("cwd"), suggestions)
    elif tool_name == "Read" and isinstance(tool_input.get("file_path"), str):
        question = read_question(tool_input, suggestions)
    elif tool_name == "WebFetch" and isinstance(tool_input.get("url"), str):
        question = fetch_question(tool_input, suggestions)
    else:
        question = generic_question(tool_name, description, details, suggestions)
    question["data"]["origin"] = origin_for(request)
    return question, updates


def claude_decision(decision: dict[str, Any]) -> None:
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}}))
    raise SystemExit(0)


def allow_decision(updates: list[dict[str, Any]] | None) -> dict[str, Any]:
    return {"behavior": "allow", **({} if updates is None else {"updatedPermissions": updates})}


def main() -> None:
    endpoint = event_endpoint()
    if not endpoint:
        normal_flow()
    try:
        request = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError):
        normal_flow()
    if not isinstance(request, dict):
        normal_flow()
    question, updates = question_for(request)
    try:
        result = subprocess.run(
            ["ptys", "event", "--request", "--timeout", str(DEFAULT_TIMEOUT_SECONDS), json.dumps(question, ensure_ascii=False)],
            check=False, capture_output=True, text=True, timeout=DEFAULT_TIMEOUT_SECONDS + 2,
            env={**os.environ, "PTYS_EVENT_ENDPOINT": endpoint},
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
    answer = response.get("answer")
    note = response.get("note")
    if answer == "allow":
        claude_decision(allow_decision(None))
    if isinstance(answer, str) and answer in updates:
        claude_decision(allow_decision(updates[answer]))
    if answer == "deny":
        claude_decision({"behavior": "deny", **({"message": note} if isinstance(note, str) and note.strip() else {})})
    normal_flow()


if __name__ == "__main__":
    main()
