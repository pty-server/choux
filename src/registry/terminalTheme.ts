import type { ITheme } from "@xterm/xterm";

export type TerminalColorKey =
  | "background"
  | "foreground"
  | "cursor"
  | "selectionBackground"
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

export type TerminalTheme = Required<Pick<ITheme, TerminalColorKey>>;

export interface TerminalSettings {
  theme: TerminalTheme;
  fontSize: number;
}

export const defaultTerminalFontSize = 15;

export const defaultTerminalTheme: TerminalTheme = {
  background: "#0d1117",
  foreground: "#c9d1d9",
  cursor: "#58a6ff",
  selectionBackground: "#264f78",
  black: "#484f58",
  red: "#ff7b72",
  green: "#7ee787",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#d2a8ff",
  cyan: "#76e3ea",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#b3f0ff",
  brightWhite: "#f0f6fc",
};

export const defaultTerminalSettings: TerminalSettings = {
  theme: defaultTerminalTheme,
  fontSize: defaultTerminalFontSize,
};

export const terminalThemePresets: { name: string; theme: TerminalTheme }[] = [
  { name: "Choux", theme: defaultTerminalTheme },
  {
    name: "Dracula",
    theme: {
      background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2", selectionBackground: "#44475a",
      black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
      blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
      brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94", brightYellow: "#ffffa5",
      brightBlue: "#d6acff", brightMagenta: "#ff92df", brightCyan: "#a4ffff", brightWhite: "#ffffff",
    },
  },
  {
    name: "Solarized Dark",
    theme: {
      background: "#002b36", foreground: "#839496", cursor: "#93a1a1", selectionBackground: "#073642",
      black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
      blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
      brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75", brightYellow: "#657b83",
      brightBlue: "#839496", brightMagenta: "#6c71c4", brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
    },
  },
];
