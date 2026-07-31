const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_MESSAGE_LENGTH = 1_500;

function clipped(value) {
  return value.length <= MAX_MESSAGE_LENGTH ? value : `${value.slice(0, MAX_MESSAGE_LENGTH)}\n\n[truncated]`;
}

function asText(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function actionLabel(permissionType) {
  if (permissionType === "bash") return "run a Bash command";
  if (permissionType === "edit") return "edit a file";
  return permissionType || "perform an action";
}

function usefulMetadata(metadata, patterns) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return metadata;
  const result = { ...metadata };
  for (const key of ["command", "path", "file_path"]) {
    if (typeof result[key] === "string" && patterns.includes(result[key])) delete result[key];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function questionFor(permission) {
  const permissionType = permission.permission ?? permission.type;
  const rawPatterns = permission.patterns ?? permission.pattern;
  const patterns = Array.isArray(rawPatterns) ? rawPatterns : rawPatterns === undefined ? [] : [rawPatterns];
  const parts = [`OpenCode requests permission to ${actionLabel(permissionType)}.`];

  if (patterns.length > 0) {
    const label = permissionType === "bash" ? "Command:" : permissionType === "edit" ? "File:" : patterns.length === 1 ? "Request:" : "Requests:";
    parts.push("", label, clipped(patterns.join("\n")));
  }
  const metadata = usefulMetadata(permission.metadata, patterns);
  if (metadata !== undefined) parts.push("", "Details:", clipped(asText(metadata)));

  return {
    type: "choux.question",
    data: {
      title: "OpenCode permission request",
      message: parts.join("\n"),
      options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }],
      notes: false,
    },
  };
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

async function askChoux(permission) {
  if (!process.env.PTYS_EVENT_ENDPOINT) return undefined;
  const ptys = await findPtys();
  if (!ptys) return undefined;

  let child;
  try {
    child = Bun.spawn([ptys, "event", "--request", "--timeout", String(DEFAULT_TIMEOUT_SECONDS), JSON.stringify(questionFor(permission))], { stdout: "pipe", stderr: "ignore" });
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
    return response?.answer === "allow" || response?.answer === "deny" ? response.answer : undefined;
  } catch {
    return undefined;
  }
}

async function replyToOpenCode(client, permission, answer) {
  const reply = answer === "allow" ? "once" : "reject";
  try {
    if (client.permission?.reply) {
      await client.permission.reply({ requestID: permission.id, reply });
    } else {
      await client.postSessionIdPermissionsPermissionId({
        path: { id: permission.sessionID, permissionID: permission.id },
        body: { response: reply },
      });
    }
  } catch {
    // Leave OpenCode's original dialog available when its reply fails.
  }
}

export const ChouxPermission = async ({ client }) => ({
  event: async ({ event }) => {
    if (event.type !== "permission.asked") return;
    const permission = event.properties;
    const answer = await askChoux(permission);
    if (answer === "allow" || answer === "deny") await replyToOpenCode(client, permission, answer);
  },
});

export default ChouxPermission;
