/** Languages the question dialog can colour. Anything else is shown unhighlighted. */
export type CommandLanguage = "bash" | "python" | "javascript" | "ruby" | "perl" | "php" | "sql" | "plain";

export interface CommandSegment {
  readonly language: CommandLanguage;
  readonly code: string;
}

interface PendingBody {
  readonly delimiter: string;
  readonly stripsTabs: boolean;
  readonly language: CommandLanguage;
}

const INTERPRETERS: ReadonlyArray<readonly [RegExp, CommandLanguage]> = [
  [/^python[\d.]*$/, "python"],
  [/^(node|deno|bun)$/, "javascript"],
  [/^(ruby|irb)$/, "ruby"],
  [/^perl$/, "perl"],
  [/^php$/, "php"],
  [/^(sqlite3|psql|mysql|mariadb)$/, "sql"],
  [/^(bash|sh|zsh|dash|ksh)$/, "bash"],
];

const OPENER = /<<-?\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w-]*))/g;

function bodyLanguage(line: string): CommandLanguage {
  const words = line.split(/[\s|;&(]+/).filter((word) => word.length > 0);
  for (const word of words) {
    const name = word.split("/").pop() ?? word;
    for (const [pattern, language] of INTERPRETERS) {
      if (pattern.test(name)) return language;
    }
  }
  return "plain";
}

/** Heredoc bodies are not shell - `python3 - <<'EOF'` feeds Python to stdin, and
 * colouring those lines with bash rules mangles their strings and comments. */
function openersIn(line: string): PendingBody[] {
  const language = bodyLanguage(line);
  const bodies: PendingBody[] = [];
  for (const match of line.matchAll(OPENER)) {
    const delimiter = match[1] ?? match[2] ?? match[3];
    if (delimiter === undefined) continue;
    bodies.push({ delimiter, stripsTabs: match[0].startsWith("<<-"), language });
  }
  return bodies;
}

function closes(line: string, body: PendingBody): boolean {
  return (body.stripsTabs ? line.replace(/^\t+/, "") : line).trimEnd() === body.delimiter;
}

/** Splits a shell command into runs of one language each, so every run can be
 * highlighted with its own grammar. A command with no heredoc yields one bash run. */
export function commandSegments(command: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  let language: CommandLanguage = "bash";
  let lines: string[] = [];
  const pending: PendingBody[] = [];

  const flush = (next: CommandLanguage): void => {
    if (lines.length > 0) segments.push({ language, code: lines.join("\n") });
    language = next;
    lines = [];
  };

  for (const line of command.split("\n")) {
    const body = pending[0];
    if (body === undefined) {
      lines.push(line);
      const opened = openersIn(line);
      if (opened.length > 0) {
        pending.push(...opened);
        flush(opened[0]!.language);
      }
      continue;
    }
    if (closes(line, body)) {
      pending.shift();
      flush("bash");
      lines.push(line);
      const queued = pending[0];
      if (queued !== undefined) flush(queued.language);
      continue;
    }
    lines.push(line);
  }
  flush("bash");
  return segments;
}
