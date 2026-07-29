export interface GlobalShortcutSettings {
  enabled: boolean;
  /** e.g. `CmdOrCtrl+Shift+Space` */
  accelerator: string;
}

export const defaultGlobalShortcutSettings: GlobalShortcutSettings = {
  enabled: false,
  accelerator: "CmdOrCtrl+Shift+Space",
};
