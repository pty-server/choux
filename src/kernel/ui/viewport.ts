// Measure the viewport size of a container element by mounting a real
// xterm.js Terminal (with FitAddon) into it. Used to size a new session
// before any AttachPane exists to attach into.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

export function measureViewport(container: HTMLElement): { cols: number; rows: number } {
  const temp = document.createElement("div");
  temp.style.width = "100%";
  temp.style.height = "100%";
  temp.style.position = "absolute";
  temp.style.top = "0";
  temp.style.left = "0";
  temp.style.visibility = "hidden";
  container.appendChild(temp);

  const term = new Terminal();
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(temp);
  fitAddon.fit();

  const cols = term.cols;
  const rows = term.rows;

  term.dispose();
  container.removeChild(temp);

  return { cols, rows };
}
