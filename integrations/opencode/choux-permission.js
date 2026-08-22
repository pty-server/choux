const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_MESSAGE_LENGTH = 1_500;
const CONTENT_PREVIEW_LENGTH = 1_000;

const TOOL_NAMES = {
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  read: "Read",
  glob: "Glob",
  grep: "Grep",
  task: "Task",
  skill: "Skill",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  external_directory: "ExternalDirectory",
};

function clipped(value) {
  return value.length <= MAX_MESSAGE_LENGTH ? value : `${value.slice(0, MAX_MESSAGE_LENGTH)}\n\n[truncated]`;
}

function preview(value) {
  return value.length <= CONTENT_PREVIEW_LENGTH ? value : `${value.slice(0, CONTENT_PREVIEW_LENGTH)}\n\n[preview truncated]`;
}

function asText(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function permissionType(permission) {
  const type = permission.permission ?? permission.type;
  return typeof type === "string" ? type : "";
}

function patternsOf(permission) {
  const raw = permission.patterns ?? permission.pattern;
  return Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
}

function callIdOf(permission) {
  const callId = permission.tool?.callID ?? permission.callID;
  return typeof callId === "string" && callId ? callId : undefined;
}

function metadataOf(permission) {
  const metadata = permission.metadata;
  return metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
}

function usefulMetadata(metadata, patterns) {
  const result = { ...metadata };
  for (const key of ["command", "path", "filepath", "file_path"]) {
    if (typeof result[key] === "string" && patterns.includes(result[key])) delete result[key];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function actionLabel(type) {
  if (type === "bash") return "run a Bash command";
  if (type === "edit") return "edit a file";
  return type || "perform an action";
}

/** OpenCode describes a file change as a unified patch. The dialog diffs two texts,
 * so split the hunks back into the side each line belongs to. */
function diffSides(patch) {
  const before = [];
  const after = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("\\")) continue;
    if (line.startsWith("@@")) {
      if (before.length > 0 || after.length > 0) {
        before.push("…");
        after.push("…");
      }
      continue;
    }
    if (line.startsWith("-")) before.push(line.slice(1));
    else if (line.startsWith("+")) after.push(line.slice(1));
    else {
      const text = line.startsWith(" ") ? line.slice(1) : line;
      before.push(text);
      after.push(text);
    }
  }
  return { before: preview(before.join("\n")), after: preview(after.join("\n")) };
}

function alwaysOption(permission) {
  const always = permission.always;
  if (!Array.isArray(always) || always.length === 0) return undefined;
  const type = permissionType(permission);
  const description = always.includes("*")
    ? `Allows every ${type || "such"} request from now on`
    : `Allows ${always.join(", ")} from now on`;
  return { id: "always", label: "Yes, don't ask again", description: clipped(description) };
}

function optionsFor(permission) {
  const always = alwaysOption(permission);
  return [
    { id: "allow", label: "Yes" },
    ...(always === undefined ? [] : [always]),
    { id: "deny", label: "No", description: "A note becomes the reason OpenCode is given" },
  ];
}

function fieldsBlock(fields) {
  const listed = fields
    .filter(([, value]) => typeof value === "string" && value.trim())
    .map(([label, value]) => ({ label, value: clipped(value.trim()) }));
  return listed.length > 0 ? [{ kind: "fields", fields: listed }] : [];
}

function commandQuestion(permission, metadata, patterns, cwd) {
  const command = typeof metadata.command === "string" && metadata.command.trim() ? metadata.command.trim() : patterns.join("\n");
  const block = { kind: "command", command: clipped(command) };
  if (cwd) block.cwd = cwd;
  return { title: "Run a command", message: "OpenCode wants to run a command.", blocks: [block] };
}

function editQuestion(permission, metadata, patterns) {
  const patch = metadata.diff;
  const path = typeof metadata.filepath === "string" ? metadata.filepath : patterns.join(", ");
  if (typeof patch !== "string" || !patch.trim()) {
    return { title: "Change a file", message: "OpenCode wants to change a file.", blocks: fieldsBlock([["File", path]]) };
  }
  const files = Array.isArray(metadata.files) ? metadata.files.length : 0;
  const block = { kind: "diff", path, ...diffSides(patch) };
  if (files > 1) block.badges = [`${files} files`];
  return { title: "Change a file", message: "OpenCode wants to change a file.", blocks: [block] };
}

function questionBody(permission, metadata, patterns, cwd) {
  const type = permissionType(permission);
  if (type === "bash") return commandQuestion(permission, metadata, patterns, cwd);
  if (type === "edit") return editQuestion(permission, metadata, patterns);
  if (type === "read") {
    return { title: "Read a file", message: "OpenCode wants to read a file.", blocks: fieldsBlock([["File", patterns.join(", ")], ["Server", metadata.server], ["Resource", metadata.uri]]) };
  }
  if (type === "webfetch") {
    return { title: "Fetch a web page", message: "OpenCode wants to fetch a URL.", blocks: fieldsBlock([["URL", metadata.url ?? patterns.join(", ")], ["Format", metadata.format]]) };
  }
  if (type === "task") {
    return { title: "Start a subagent", message: "OpenCode wants to start a subagent.", blocks: fieldsBlock([["Agent", metadata.subagent_type ?? patterns.join(", ")], ["Task", metadata.description]]) };
  }
  if (type === "external_directory") {
    return {
      title: "Work outside the project",
      message: "OpenCode wants to touch a path outside the project directory.",
      blocks: fieldsBlock([["Path", metadata.filepath], ["Directory", metadata.parentDir], ["Command", metadata.command], ["Patterns", patterns.join("\n")]]),
    };
  }

  const parts = [`OpenCode requests permission to ${actionLabel(type)}.`];
  if (patterns.length > 0) {
    parts.push("", patterns.length === 1 ? "Request:" : "Requests:", clipped(patterns.join("\n")));
  }
  const rest = usefulMetadata(metadata, patterns);
  if (rest !== undefined) parts.push("", "Details:", clipped(asText(rest)));
  return { title: "OpenCode permission request", message: parts.join("\n"), blocks: [] };
}

/** Lets Choux withdraw the question when the state reporter says this same tool call
 * settled - the request was answered in OpenCode's own dialog instead. */
function originFor(permission) {
  const origin = { agent: "opencode" };
  if (typeof permission.sessionID === "string" && permission.sessionID) origin.agentSessionId = permission.sessionID;
  const tool = TOOL_NAMES[permissionType(permission)];
  if (tool !== undefined) origin.tool = tool;
  const callId = callIdOf(permission);
  if (callId !== undefined) origin.toolUseId = callId;
  return origin;
}

function questionFor(permission, cwd) {
  const metadata = metadataOf(permission);
  const patterns = patternsOf(permission);
  const { title, message, blocks } = questionBody(permission, metadata, patterns, cwd);
  return {
    type: "choux.question",
    data: {
      title,
      message,
      options: optionsFor(permission),
      origin: originFor(permission),
      ...(blocks.length > 0 ? { blocks } : {}),
    },
  };
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

/** A tmux pane outlives the server that spawned it, so the inherited endpoint can
 * point at a dead URL. Tmux tracks the live value - prefer it inside tmux. */
async function eventEndpoint() {
  const tracked = process.env.TMUX ? await readTmuxEndpoint() : undefined;
  const inherited = process.env.PTYS_EVENT_ENDPOINT;
  return tracked ?? (inherited ? inherited : undefined);
}

async function findPtys() {
  const direct = Bun.which("ptys");
  if (direct) return direct;
  try {
    const lookup = Bun.spawn(["sh", "-lc", "command -v ptys"], { stdout: "pipe", stderr: "ignore" });
    if (await lookup.exited !== 0) return undefined;
    return (await new Response(lookup.stdout).text()).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function askChoux(permission, cwd) {
  const endpoint = await eventEndpoint();
  if (endpoint === undefined) return undefined;
  const ptys = await findPtys();
  if (!ptys) return undefined;

  let child;
  try {
    child = Bun.spawn([ptys, "event", "--request", "--timeout", String(DEFAULT_TIMEOUT_SECONDS), JSON.stringify(questionFor(permission, cwd))], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, PTYS_EVENT_ENDPOINT: endpoint },
    });
  } catch {
    return undefined;
  }
  const timedOut = await Promise.race([
    child.exited.then((exitCode) => exitCode !== 0),
    new Promise((resolve) => setTimeout(() => resolve(true), (DEFAULT_TIMEOUT_SECONDS + 2) * 1_000)),
  ]);
  if (timedOut) {
    child.kill();
    return undefined;
  }
  try {
    const response = JSON.parse(await new Response(child.stdout).text());
    if (response?.cancelled === true) return undefined;
    const reply = { allow: "once", always: "always", deny: "reject" }[response?.answer];
    if (reply === undefined) return undefined;
    const note = typeof response.note === "string" && response.note.trim() ? response.note.trim() : undefined;
    return { reply, message: reply === "reject" ? note : undefined };
  } catch {
    return undefined;
  }
}

async function replyToOpenCode(client, permission, answer) {
  try {
    if (client.permission?.reply) {
      await client.permission.reply({ requestID: permission.id, reply: answer.reply, ...(answer.message === undefined ? {} : { message: answer.message }) });
    } else {
      await client.postSessionIdPermissionsPermissionId({
        path: { id: permission.sessionID, permissionID: permission.id },
        body: { response: answer.reply },
      });
    }
  } catch {
    // Leave OpenCode's original dialog available when its reply fails.
  }
}

export const ChouxPermission = async ({ client, directory }) => ({
  event: async ({ event }) => {
    if (event.type !== "permission.asked") return;
    const permission = event.properties;
    const answer = await askChoux(permission, directory);
    if (answer !== undefined) await replyToOpenCode(client, permission, answer);
  },
});

export default ChouxPermission;
