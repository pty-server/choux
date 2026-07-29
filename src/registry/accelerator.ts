const modifierLabels: Record<string, string> = {
  CMDORCTRL: "Cmd/Ctrl",
  CONTROL: "Ctrl",
  ALT: "Alt",
  SHIFT: "Shift",
  SUPER: "Super",
};

const keyPattern = /^(?:Key[A-Z]|Digit[0-9]|Numpad[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(?:Up|Down|Left|Right)|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/;

function isModifier(part: string): boolean {
  return part.toUpperCase() in modifierLabels;
}

/** Shift alone is rejected: Shift+letter would swallow ordinary typing. */
export function isValidAccelerator(accelerator: string): boolean {
  const parts = accelerator.split("+").filter((part) => part.length > 0);
  if (parts.length < 2) return false;
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  if (isModifier(key) || !keyPattern.test(key)) return false;
  if (!modifiers.every(isModifier)) return false;
  return modifiers.some((modifier) => modifier.toUpperCase() !== "SHIFT");
}

export type AcceleratorKeyEvent = {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
};

export function acceleratorFromKeyboardEvent(event: AcceleratorKeyEvent): string | undefined {
  if (!keyPattern.test(event.code)) return undefined;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Control");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Super");
  parts.push(event.code);
  const accelerator = parts.join("+");
  return isValidAccelerator(accelerator) ? accelerator : undefined;
}

function describeKey(key: string): string {
  if (/^Key[A-Z]$/.test(key)) return key.slice(3);
  if (/^Digit[0-9]$/.test(key)) return key.slice(5);
  if (/^Arrow/.test(key)) return key.slice(5);
  return key;
}

export function describeAccelerator(accelerator: string): string {
  const parts = accelerator.split("+").filter((part) => part.length > 0);
  return parts
    .map((part, index) =>
      index === parts.length - 1 ? describeKey(part) : (modifierLabels[part.toUpperCase()] ?? part),
    )
    .join(" + ");
}
