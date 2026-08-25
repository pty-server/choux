import { describe, it, expect } from "vitest";
import { commandSegments } from "./heredoc";

describe("commandSegments", () => {
  it("keeps a plain command as one bash run", () => {
    expect(commandSegments("npm test -- --run")).toEqual([{ language: "bash", code: "npm test -- --run" }]);
  });

  it("colours a python heredoc body as python and its delimiters as bash", () => {
    expect(commandSegments("python3 - <<'EOF'\nimport re\nprint(re.escape('x'))\nEOF\necho done")).toEqual([
      { language: "bash", code: "python3 - <<'EOF'" },
      { language: "python", code: "import re\nprint(re.escape('x'))" },
      { language: "bash", code: "EOF\necho done" },
    ]);
  });

  it("reads the interpreter through a path and a pipeline", () => {
    expect(commandSegments("cat x | /usr/bin/node - <<JS\nconsole.log(1)\nJS").map((segment) => segment.language)).toEqual([
      "bash",
      "javascript",
      "bash",
    ]);
  });

  it("leaves a body with no known interpreter unhighlighted", () => {
    expect(commandSegments("cat <<EOF > notes.txt\nfree text\nEOF")).toEqual([
      { language: "bash", code: "cat <<EOF > notes.txt" },
      { language: "plain", code: "free text" },
      { language: "bash", code: "EOF" },
    ]);
  });

  it("closes only on the exact delimiter line and allows tab stripping with <<-", () => {
    expect(commandSegments("python3 <<-EOF\nEOF is not the end\n\tEOF\ndone")).toEqual([
      { language: "bash", code: "python3 <<-EOF" },
      { language: "python", code: "EOF is not the end" },
      { language: "bash", code: "\tEOF\ndone" },
    ]);
  });

  it("does not strip tabs for a plain <<", () => {
    expect(commandSegments("python3 <<EOF\n\tEOF\nEOF").map((segment) => segment.code)).toEqual([
      "python3 <<EOF",
      "\tEOF",
      "EOF",
    ]);
  });

  it("runs an unterminated body to the end of the command", () => {
    expect(commandSegments("python3 - <<'EOF'\nimport re")).toEqual([
      { language: "bash", code: "python3 - <<'EOF'" },
      { language: "python", code: "import re" },
    ]);
  });

  it("picks a fresh language for a later heredoc in the same command", () => {
    expect(commandSegments("diff <(python3 - <<'A'\none\nA\n) <(sqlite3 db <<B\nselect 1;\nB\n)")).toEqual([
      { language: "bash", code: "diff <(python3 - <<'A'" },
      { language: "python", code: "one" },
      { language: "bash", code: "A\n) <(sqlite3 db <<B" },
      { language: "sql", code: "select 1;" },
      { language: "bash", code: "B\n)" },
    ]);
  });

  it("ignores a heredoc opener that appears inside a body", () => {
    expect(commandSegments("python3 - <<'EOF'\nprint('cat <<INNER')\nEOF")).toEqual([
      { language: "bash", code: "python3 - <<'EOF'" },
      { language: "python", code: "print('cat <<INNER')" },
      { language: "bash", code: "EOF" },
    ]);
  });
});
