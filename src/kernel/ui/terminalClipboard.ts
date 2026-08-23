// Clipboard glue shared by the attach pane (which owns the xterm instance) and
// the shell (which owns commands and keybindings). The pane publishes itself
// here on mount so a command can act on whatever terminal is focused.

export interface TerminalClipboardTarget {
  copySelection(): Promise<boolean>;
  paste(): Promise<void>;
  selectAll(): void;
}

let active: TerminalClipboardTarget | undefined;

export function setActiveTerminalClipboard(target: TerminalClipboardTarget): void {
  active = target;
}

export function clearActiveTerminalClipboard(target: TerminalClipboardTarget): void {
  if (active === target) active = undefined;
}

export function activeTerminalClipboard(): TerminalClipboardTarget | undefined {
  return active;
}

const maxOsc52Payload = 1_000_000;
const selectionTargets = /^[cpqs0-7]*$/;

/** Returns the text an `OSC 52` sequence wants copied, or `undefined` for anything not worth honouring. */
export function decodeOsc52(data: string): string | undefined {
  const separator = data.indexOf(";");
  if (separator === -1) return undefined;

  const targets = data.slice(0, separator);
  if (!selectionTargets.test(targets)) return undefined;

  // `?` is a read request; answering it would hand the remote our clipboard.
  const payload = data.slice(separator + 1);
  if (payload.length === 0 || payload === "?" || payload.length > maxOsc52Payload) return undefined;

  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/** Without bracketed paste, every newline but a single trailing one runs a command the moment it lands. */
export function needsMultilinePasteConfirm(text: string, bracketedPaste: boolean): boolean {
  if (bracketedPaste) return false;
  return /[\r\n]/.test(text.replace(/\r?\n$/, ""));
}
