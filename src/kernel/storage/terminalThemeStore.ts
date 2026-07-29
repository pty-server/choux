import { metaStoreName, openDatabase } from "./db";
import {
  defaultTerminalFontSize,
  defaultTerminalTheme,
  type TerminalSettings,
  type TerminalTheme,
} from "../../registry/terminalTheme";

export type { TerminalColorKey, TerminalSettings, TerminalTheme } from "../../registry/terminalTheme";

const terminalThemeKey = "terminalTheme";

function normalizeTheme(value: unknown): TerminalTheme {
  if (!value || typeof value !== "object") return { ...defaultTerminalTheme };
  const saved = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(defaultTerminalTheme).map(([key, fallback]) => [key, typeof saved[key] === "string" ? saved[key] : fallback]),
  ) as TerminalTheme;
}

function normalizeSettings(value: unknown): TerminalSettings {
  if (!value || typeof value !== "object") {
    return { theme: { ...defaultTerminalTheme }, fontSize: defaultTerminalFontSize };
  }
  const saved = value as Record<string, unknown>;
  // Color-only values were saved before font size was configurable.
  const fontSize = typeof saved.fontSize === "number" && Number.isInteger(saved.fontSize)
    ? Math.min(32, Math.max(8, saved.fontSize))
    : defaultTerminalFontSize;
  return {
    theme: normalizeTheme(saved.theme ?? saved),
    fontSize,
  };
}

export async function getTerminalSettings(): Promise<TerminalSettings> {
  const db = await openDatabase();
  const saved = await new Promise<unknown>((resolve, reject) => {
    const request = db.transaction(metaStoreName).objectStore(metaStoreName).get(terminalThemeKey);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return normalizeSettings(saved);
}

export async function saveTerminalSettings(settings: TerminalSettings): Promise<void> {
  const db = await openDatabase();
  const normalized = normalizeSettings(settings);
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(metaStoreName, "readwrite").objectStore(metaStoreName).put(normalized, terminalThemeKey);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// Retained for callers that only manage terminal colors.
export async function getTerminalTheme(): Promise<TerminalTheme> {
  return (await getTerminalSettings()).theme;
}

export async function saveTerminalTheme(theme: TerminalTheme): Promise<void> {
  const { fontSize } = await getTerminalSettings();
  await saveTerminalSettings({ theme, fontSize });
}
