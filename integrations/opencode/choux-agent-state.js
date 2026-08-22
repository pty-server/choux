const POST_TIMEOUT_MS = 500;
const DETAIL_LENGTH = 256;
const TMUX_ENDPOINT_TTL_MS = 30_000;

const TOOL_NAMES = {
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  read: "Read",
  list: "List",
  glob: "Glob",
  grep: "Grep",
  task: "Task",
  patch: "Patch",
  skill: "Skill",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  todowrite: "TodoWrite",
  todoread: "TodoRead",
};

const DETAIL_KEYS = {
  Bash: "command",
  Edit: "filePath",
  Write: "filePath",
  Read: "filePath",
  List: "path",
  Glob: "pattern",
  Grep: "pattern",
  Task: "description",
  Patch: "filePath",
  Skill: "name",
  WebFetch: "url",
  WebSearch: "query",
};

function toolNameFor(tool) {
  return typeof tool === "string" && tool ? TOOL_NAMES[tool] ?? tool : undefined;
}

function clipped(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.trim();
  return text.length <= DETAIL_LENGTH ? text : `${text.slice(0, DETAIL_LENGTH)}…`;
}

function detailFor(toolName, args) {
  if (toolName === undefined || args === null || typeof args !== "object") return undefined;
  const key = DETAIL_KEYS[toolName];
  return key === undefined ? undefined : clipped(args[key]);
}

async function readTmuxEndpoint() {
  try {
    const child = Bun.spawn(["tmux", "show-environment", "PTYS_EVENT_ENDPOINT"], { stdout: "pipe", stderr: "ignore" });
    if (await child.exited !== 0) return undefined;
    const line = (await new Response(child.stdout).text()).trim();
    return line.startsWith("PTYS_EVENT_ENDPOINT=") ? line.slice("PTYS_EVENT_ENDPOINT=".length) : undefined;
  } catch {
    return undefined;
  }
}

let tmuxTracked = { value: undefined, at: 0 };

async function tmuxEndpoint() {
  if (!process.env.TMUX) return undefined;
  const now = Date.now();
  if (now - tmuxTracked.at < TMUX_ENDPOINT_TTL_MS) return tmuxTracked.value;
  tmuxTracked = { value: await readTmuxEndpoint(), at: now };
  return tmuxTracked.value;
}

/** A tmux pane outlives the server that spawned it, so the inherited endpoint can
 * point at a dead URL. Tmux tracks the live value - prefer it inside tmux. */
async function endpointCandidates() {
  const ordered = [await tmuxEndpoint(), process.env.PTYS_EVENT_ENDPOINT];
  return [...new Set(ordered.filter((value) => typeof value === "string" && value.length > 0))];
}

async function post(endpoint, body) {
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  };
  if (!endpoint.startsWith("http+unix:")) return (await fetch(endpoint, init)).ok;

  const rest = endpoint.slice("http+unix:".length);
  const separator = rest.lastIndexOf(":/");
  if (separator < 0) return false;
  const response = await fetch(`http://localhost${rest.slice(separator + 1)}`, { ...init, unix: rest.slice(0, separator) });
  return response.ok;
}

async function publish(data) {
  const body = JSON.stringify({ type: "choux.agent.state", data, request: false });
  for (const endpoint of await endpointCandidates()) {
    try {
      if (await post(endpoint, body)) return;
    } catch {
      continue;
    }
  }
}

/** An approved request leaves the tool it guards running, so put that back on the badge -
 * except for `task`, whose subagent the reporter already counted when it started. */
function resumedEvent(asked) {
  return asked?.tool === "Task" ? "PostToolUse" : "PreToolUse";
}

export const ChouxAgentState = async ({ directory }) => {
  const asked = new Map();

  const report = (state) => {
    void publish({
      agent: "opencode",
      at: Date.now(),
      pid: process.pid,
      pane: process.env.TMUX_PANE,
      cwd: directory,
      ...state,
    }).catch(() => undefined);
  };

  const permissionAsked = (request) => {
    const tool = toolNameFor(request.permission ?? request.type);
    const callId = request.tool?.callID ?? request.callID;
    const patterns = Array.isArray(request.patterns) ? request.patterns : [request.pattern];
    const detail = clipped(request.title) ?? detailFor(tool, request.metadata) ?? clipped(patterns[0]);
    if (typeof callId === "string" && callId) {
      asked.set(request.id, { callId, sessionId: request.sessionID, tool, detail });
    }
    report({ event: "PermissionRequest", agentSessionId: request.sessionID, toolUseId: callId, tool, detail });
  };

  /** Answered in OpenCode's own dialog instead of ours - report the tool call settled
   * so Choux withdraws the question it still has open for it. */
  const permissionReplied = (properties) => {
    const requestId = properties.requestID ?? properties.permissionID;
    const request = asked.get(requestId);
    asked.delete(requestId);
    const rejected = (properties.reply ?? properties.response) === "reject";
    report({
      event: rejected ? "PermissionDenied" : resumedEvent(request),
      agentSessionId: properties.sessionID,
      toolUseId: request?.callId,
      ...(rejected ? {} : { tool: request?.tool, detail: request?.detail }),
    });
  };

  /** A run can end with a request never answered - drop what was tracked for it. */
  const sessionEnded = (sessionId, event) => {
    for (const [requestId, request] of asked) {
      if (request.sessionId === sessionId) asked.delete(requestId);
    }
    report({ event, agentSessionId: sessionId });
  };

  return {
    event: async ({ event }) => {
      try {
        if (event.type === "permission.asked" || event.type === "permission.updated") permissionAsked(event.properties);
        else if (event.type === "permission.replied") permissionReplied(event.properties);
        else if (event.type === "session.idle" || event.type === "session.error") sessionEnded(event.properties.sessionID, "Stop");
        else if (event.type === "session.deleted") sessionEnded(event.properties.sessionID ?? event.properties.info?.id, "SessionEnd");
      } catch {
        // Never let reporting disturb the agent.
      }
    },
    "chat.message": async ({ sessionID }) => {
      report({ event: "UserPromptSubmit", agentSessionId: sessionID });
    },
    "tool.execute.before": async ({ tool, sessionID, callID }, output) => {
      const toolName = toolNameFor(tool);
      report({
        event: "PreToolUse",
        agentSessionId: sessionID,
        toolUseId: callID,
        tool: toolName,
        detail: detailFor(toolName, output?.args),
      });
    },
    "tool.execute.after": async ({ tool, sessionID, callID }) => {
      const toolName = toolNameFor(tool);
      report({
        event: toolName === "Task" ? "SubagentStop" : "PostToolUse",
        agentSessionId: sessionID,
        toolUseId: callID,
        tool: toolName,
      });
    },
    "experimental.session.compacting": async ({ sessionID }) => {
      report({ event: "PreCompact", agentSessionId: sessionID });
    },
  };
};

export default ChouxAgentState;
