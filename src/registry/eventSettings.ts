export interface EventSettings {
  handleQuestions: boolean;
  revealWindow: boolean;
  followAttention: boolean;
}

export const defaultEventSettings: EventSettings = {
  handleQuestions: true,
  revealWindow: true,
  followAttention: false,
};

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeEventSettings(value: unknown): EventSettings {
  if (typeof value !== "object" || value === null) return { ...defaultEventSettings };
  const record = value as Record<string, unknown>;
  return {
    handleQuestions: boolOr(record.handleQuestions, defaultEventSettings.handleQuestions),
    revealWindow: boolOr(record.revealWindow, defaultEventSettings.revealWindow),
    followAttention: boolOr(record.followAttention, defaultEventSettings.followAttention),
  };
}

export function eventSettingsEqual(a: EventSettings, b: EventSettings): boolean {
  return a.handleQuestions === b.handleQuestions
    && a.revealWindow === b.revealWindow
    && a.followAttention === b.followAttention;
}