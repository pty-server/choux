#!/usr/bin/env python3
"""Report Claude Code's activity to Choux as a `choux.agent.state` event."""

import http.client
import json
import os
import socket
import subprocess
import sys
import time
from typing import Any
from urllib.parse import urlsplit


TIMEOUT_SECONDS = 0.5
DETAIL_LENGTH = 256

class DeliveryFailed(Exception):
    pass


DETAIL_KEYS = {
    "Bash": "command",
    "Write": "file_path",
    "Edit": "file_path",
    "Read": "file_path",
    "Glob": "pattern",
    "Grep": "pattern",
    "Task": "description",
    "WebFetch": "url",
}


def endpoint_target(value: str) -> tuple[str | None, str, int, str, str]:
    if value.startswith("http+unix:"):
        rest = value[len("http+unix:"):]
        separator = rest.rfind(":/")
        if separator < 0:
            raise ValueError("invalid endpoint")
        return rest[:separator], "localhost", 80, "http", rest[separator + 1:]

    parsed = urlsplit(value)
    path = parsed.path + (f"?{parsed.query}" if parsed.query else "")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return None, parsed.hostname or "localhost", port, parsed.scheme, path


def publish(endpoint: str, data: dict[str, Any]) -> None:
    socket_path, host, port, scheme, path = endpoint_target(endpoint)
    body = json.dumps({"type": "choux.agent.state", "data": data, "request": False})

    if socket_path is None and scheme == "https":
        connection: http.client.HTTPConnection = http.client.HTTPSConnection(host, port, timeout=TIMEOUT_SECONDS)
    else:
        connection = http.client.HTTPConnection(host, port, timeout=TIMEOUT_SECONDS)

    if socket_path is not None:
        unix = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        unix.settimeout(TIMEOUT_SECONDS)
        unix.connect(socket_path)
        connection.sock = unix

    try:
        connection.request("POST", path, body, {"content-type": "application/json"})
        response = connection.getresponse()
        status = response.status
        response.read()
        if not 200 <= status < 300:
            raise DeliveryFailed(f"endpoint answered {status}")
    finally:
        connection.close()


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


def clipped(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    return text if len(text) <= DETAIL_LENGTH else f"{text[:DETAIL_LENGTH]}…"


def detail_for(tool_name: object, tool_input: object) -> str | None:
    if not isinstance(tool_name, str) or not isinstance(tool_input, dict):
        return None
    key = DETAIL_KEYS.get(tool_name)
    return None if key is None else clipped(tool_input.get(key))


def state_for(request: dict[str, Any]) -> dict[str, Any]:
    data: dict[str, Any] = {
        "agent": "claude-code",
        "event": request.get("hook_event_name"),
        "at": int(time.time() * 1000),
        "pid": os.getpid(),
    }
    for key, value in (
        ("pane", os.environ.get("TMUX_PANE")),
        ("cwd", request.get("cwd")),
        ("agentSessionId", request.get("session_id")),
        ("tool", request.get("tool_name")),
        ("detail", detail_for(request.get("tool_name"), request.get("tool_input"))),
        ("message", request.get("message")),
    ):
        if isinstance(value, str) and value:
            data[key] = value
    return data


def main() -> None:
    if not os.environ.get("PTYS_EVENT_ENDPOINT") and not os.environ.get("TMUX"):
        return
    request = json.load(sys.stdin)
    if not isinstance(request, dict) or not isinstance(request.get("hook_event_name"), str):
        return
    data = state_for(request)

    for endpoint in endpoint_candidates():
        try:
            publish(endpoint, data)
            return
        except (OSError, ValueError, http.client.HTTPException, DeliveryFailed):
            continue


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
