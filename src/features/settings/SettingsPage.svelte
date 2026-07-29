<script lang="ts">
  import {
    defaultTerminalSettings,
    terminalThemePresets,
    type TerminalColorKey,
    type TerminalSettings,
    type TerminalTheme,
  } from "../../registry/terminalTheme";

  import { acceleratorFromKeyboardEvent, describeAccelerator } from "../../registry/accelerator";
  import type { GlobalShortcutSettings } from "../../registry/globalShortcut";
  import {
    bindableCommands,
    conflictingCommandIds,
    resolveKeybindings,
    type KeybindingOverrides,
  } from "../../registry/keybindings";

  interface Props {
    settings: TerminalSettings;
    onSave: (settings: TerminalSettings) => Promise<void>;
    onClose: () => void;
    globalShortcut: GlobalShortcutSettings;
    globalShortcutSupported: boolean;
    onSaveGlobalShortcut: (settings: GlobalShortcutSettings) => Promise<string | undefined>;
    keybindingOverrides: KeybindingOverrides;
    isMac: boolean;
    onSaveKeybindings: (overrides: KeybindingOverrides) => Promise<void>;
  }

  let {
    settings,
    onSave,
    onClose,
    globalShortcut,
    globalShortcutSupported,
    onSaveGlobalShortcut,
    keybindingOverrides,
    isMac,
    onSaveKeybindings,
  }: Props = $props();
  let draft = $derived<TerminalSettings>({ ...settings, theme: { ...settings.theme } });
  let saving = $state(false);

  let shortcutDraft = $derived<GlobalShortcutSettings>({ ...globalShortcut });
  let capturing = $state(false);
  let shortcutSaving = $state(false);
  let shortcutError = $state("");

  function captureShortcut(event: KeyboardEvent) {
    if (event.key === "Escape") { capturing = false; return; }
    event.preventDefault();
    const accelerator = acceleratorFromKeyboardEvent(event);
    if (!accelerator) return;
    shortcutDraft = { ...shortcutDraft, accelerator };
    capturing = false;
  }

  function isShortcutDirty() {
    return shortcutDraft.enabled !== globalShortcut.enabled
      || shortcutDraft.accelerator !== globalShortcut.accelerator;
  }

  async function saveShortcut() {
    shortcutSaving = true;
    shortcutError = "";
    try {
      shortcutError = (await onSaveGlobalShortcut(shortcutDraft)) ?? "";
    } finally {
      shortcutSaving = false;
    }
  }

  let bindingDraft = $derived<KeybindingOverrides>({ ...keybindingOverrides });
  let capturingCommandId = $state<string | undefined>(undefined);
  let bindingsSaving = $state(false);

  let resolvedBindings = $derived(resolveKeybindings(bindingDraft, isMac));
  let bindingConflicts = $derived(new Set(conflictingCommandIds(resolvedBindings)));

  function captureBinding(commandId: string, event: KeyboardEvent) {
    if (event.key === "Escape") { capturingCommandId = undefined; return; }
    event.preventDefault();
    const accelerator = acceleratorFromKeyboardEvent(event);
    if (!accelerator) return;
    bindingDraft = { ...bindingDraft, [commandId]: accelerator };
    capturingCommandId = undefined;
  }

  function clearBinding(commandId: string) {
    capturingCommandId = undefined;
    bindingDraft = { ...bindingDraft, [commandId]: null };
  }

  function restoreBinding(commandId: string) {
    capturingCommandId = undefined;
    bindingDraft = Object.fromEntries(Object.entries(bindingDraft).filter(([id]) => id !== commandId));
  }

  function areBindingsDirty() {
    const commandIds = new Set([...Object.keys(bindingDraft), ...Object.keys(keybindingOverrides)]);
    return [...commandIds].some((commandId) => bindingDraft[commandId] !== keybindingOverrides[commandId]);
  }

  async function saveBindings() {
    bindingsSaving = true;
    try {
      await onSaveKeybindings(bindingDraft);
    } finally {
      bindingsSaving = false;
    }
  }

  const baseColors: { key: TerminalColorKey; label: string }[] = [
    { key: "background", label: "Background" },
    { key: "foreground", label: "Foreground" },
    { key: "cursor", label: "Cursor" },
    { key: "selectionBackground", label: "Selection" },
  ];
  const ansiColors: { key: TerminalColorKey; label: string }[] = [
    { key: "black", label: "Black" }, { key: "red", label: "Red" },
    { key: "green", label: "Green" }, { key: "yellow", label: "Yellow" },
    { key: "blue", label: "Blue" }, { key: "magenta", label: "Magenta" },
    { key: "cyan", label: "Cyan" }, { key: "white", label: "White" },
  ];
  const brightAnsiColors: { key: TerminalColorKey; label: string }[] = [
    { key: "brightBlack", label: "Bright black" }, { key: "brightRed", label: "Bright red" },
    { key: "brightGreen", label: "Bright green" }, { key: "brightYellow", label: "Bright yellow" },
    { key: "brightBlue", label: "Bright blue" }, { key: "brightMagenta", label: "Bright magenta" },
    { key: "brightCyan", label: "Bright cyan" }, { key: "brightWhite", label: "Bright white" },
  ];

  function changeColor(key: TerminalColorKey, event: Event) {
    draft = { ...draft, theme: { ...draft.theme, [key]: (event.currentTarget as HTMLInputElement).value } };
  }

  function applyTheme(nextTheme: TerminalTheme) {
    draft = { ...draft, theme: { ...nextTheme } };
  }

  function changeFontSize(event: Event) {
    const fontSize = Number((event.currentTarget as HTMLInputElement).value);
    if (Number.isInteger(fontSize)) draft = { ...draft, fontSize: Math.min(32, Math.max(8, fontSize)) };
  }

  async function save() {
    saving = true;
    try {
      await onSave(draft);
    } finally {
      saving = false;
    }
  }

  function isDirty() {
    return draft.fontSize !== settings.fontSize
      || Object.keys(draft.theme).some((key) => draft.theme[key as TerminalColorKey] !== settings.theme[key as TerminalColorKey]);
  }
</script>

<section class="settings-page" aria-labelledby="settings-title">
  <header>
    <div>
      <h1 id="settings-title">Settings</h1>
      <p>Terminal appearance applies to every session.</p>
    </div>
    <button type="button" class="close" onclick={onClose}>Back to terminal</button>
  </header>

  {#if globalShortcutSupported}
    <section class="settings-card shortcut-card">
      <div class="card-heading">
        <div>
          <h2>Global shortcut</h2>
          <p>Brings Choux to the front from anywhere, and hides it again when it already has focus.</p>
        </div>
      </div>

      <div class="shortcut-row">
        <label class="toggle">
          <input type="checkbox" checked={shortcutDraft.enabled} onchange={(event) => (shortcutDraft = { ...shortcutDraft, enabled: event.currentTarget.checked })} />
          <span>Enabled</span>
        </label>
        <button type="button" class="capture" class:capturing onclick={() => (capturing = !capturing)} onkeydown={captureShortcut}>
          {capturing ? "Press a combination…" : describeAccelerator(shortcutDraft.accelerator)}
        </button>
        <button type="button" class="save" disabled={!isShortcutDirty() || shortcutSaving} onclick={() => void saveShortcut()}>{shortcutSaving ? "Saving…" : "Save shortcut"}</button>
      </div>

      {#if shortcutError}
        <p class="shortcut-error" role="alert">{shortcutError}</p>
      {:else}
        <p>Needs a modifier other than Shift. Escape cancels capture.</p>
      {/if}
    </section>
  {/if}

  <section class="settings-card shortcut-card">
    <div class="card-heading">
      <div>
        <h2>Keyboard shortcuts</h2>
        <p>Reserved inside Choux - every other key goes straight to the terminal.</p>
      </div>
      <button type="button" class="save" disabled={!areBindingsDirty() || bindingsSaving || bindingConflicts.size > 0} onclick={() => void saveBindings()}>{bindingsSaving ? "Saving…" : "Save shortcuts"}</button>
    </div>

    <ul class="bindings">
      {#each bindableCommands as command (command.commandId)}
        <li class:conflict={bindingConflicts.has(command.commandId)}>
          <span>{command.title}</span>
          <button type="button" class="capture" class:capturing={capturingCommandId === command.commandId} onclick={() => (capturingCommandId = capturingCommandId === command.commandId ? undefined : command.commandId)} onkeydown={(event) => captureBinding(command.commandId, event)}>
            {#if capturingCommandId === command.commandId}
              Press a combination…
            {:else if resolvedBindings[command.commandId]}
              {describeAccelerator(resolvedBindings[command.commandId])}
            {:else}
              Unbound
            {/if}
          </button>
          <button type="button" onclick={() => clearBinding(command.commandId)} disabled={bindingDraft[command.commandId] === null}>Clear</button>
          <button type="button" onclick={() => restoreBinding(command.commandId)} disabled={bindingDraft[command.commandId] === undefined}>Default</button>
        </li>
      {/each}
    </ul>

    {#if bindingConflicts.size > 0}
      <p class="shortcut-error" role="alert">Two commands share a shortcut. Change one before saving.</p>
    {:else}
      <p>Needs a modifier other than Shift. Escape cancels capture.</p>
    {/if}
  </section>

  <section class="settings-card">
    <div class="card-heading">
      <div>
        <h2>Terminal colors</h2>
        <p>Choose a preset or tune each color below.</p>
      </div>
      <div class="preset-buttons" aria-label="Terminal color presets">
        {#each terminalThemePresets as preset (preset.name)}
          <button type="button" onclick={() => applyTheme(preset.theme)}>{preset.name}</button>
        {/each}
      </div>
    </div>

    <h3>Font size</h3>
    <label class="font-size">
      <span>Size</span>
      <input type="number" min="8" max="32" step="1" value={draft.fontSize} oninput={changeFontSize} />
      <span>px</span>
    </label>

    <div class="preview" style={`--terminal-bg: ${draft.theme.background}; --terminal-fg: ${draft.theme.foreground}; --terminal-cursor: ${draft.theme.cursor}; --terminal-selection: ${draft.theme.selectionBackground}; font-size: ${draft.fontSize}px;`}>
      <span>~/workspace $ </span><span class="prompt">git status</span>
      <span class="green">On branch main</span>
      <span class="yellow">Changes not staged for commit</span>
      <span class="cursor"> </span>
    </div>

    <h3>Base colors</h3>
    <div class="color-grid base-grid">
      {#each baseColors as color (color.key)}
        <label>
          <span>{color.label}</span>
          <input type="color" value={draft.theme[color.key]} oninput={(event) => changeColor(color.key, event)} />
          <code>{draft.theme[color.key]}</code>
        </label>
      {/each}
    </div>

    <h3>ANSI colors</h3>
    <div class="color-grid">
      {#each ansiColors as color (color.key)}
        <label>
          <span>{color.label}</span>
          <input type="color" value={draft.theme[color.key]} oninput={(event) => changeColor(color.key, event)} />
          <code>{draft.theme[color.key]}</code>
        </label>
      {/each}
    </div>

    <h3>Bright ANSI colors</h3>
    <div class="color-grid">
      {#each brightAnsiColors as color (color.key)}
        <label>
          <span>{color.label}</span>
          <input type="color" value={draft.theme[color.key]} oninput={(event) => changeColor(color.key, event)} />
          <code>{draft.theme[color.key]}</code>
        </label>
      {/each}
    </div>

    <div class="actions">
      <button type="button" onclick={() => (draft = { ...defaultTerminalSettings, theme: { ...defaultTerminalSettings.theme } })}>Restore default</button>
      <button type="button" class="save" disabled={!isDirty() || saving} onclick={() => void save()}>{saving ? "Saving…" : "Save settings"}</button>
    </div>
  </section>
</section>

<style>
  .settings-page { width: min(100%, 960px); height: 100%; margin: 0 auto; padding: var(--sp-4); overflow: auto; }
  header, .card-heading, .actions { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); }
  header { margin-bottom: var(--sp-4); }
  h1, h2, h3, p { margin: 0; }
  h1 { font-size: 1.15rem; }
  h2 { font-size: 1rem; }
  h3 { margin-top: var(--sp-4); font-size: 0.9rem; }
  p { color: var(--fg-dim); font-size: 0.85rem; }
  button { padding: var(--sp-1) var(--sp-3); border: 1px solid var(--border); border-radius: 3px; background: var(--bg); color: var(--fg); cursor: pointer; }
  button:hover { border-color: var(--fg-dim); }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .settings-card { padding: var(--sp-4); border: 1px solid var(--border); border-radius: 6px; background: var(--bg-elevated); }
  .shortcut-card { margin-bottom: var(--sp-4); }
  .shortcut-row { display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--sp-3); }
  .toggle { grid-template-columns: auto auto; padding: var(--sp-1) var(--sp-2); }
  .toggle input { grid-row: auto; width: auto; height: auto; }
  .capture { min-width: 14rem; font-family: "LiterationMono Nerd Font Mono", monospace; }
  .capture.capturing { border-color: var(--accent); color: var(--accent); }
  .shortcut-error { margin-top: var(--sp-2); color: #ff7b72; font-size: 0.85rem; }
  .bindings { display: flex; flex-direction: column; gap: var(--sp-1); margin: var(--sp-3) 0 0; padding: 0; list-style: none; }
  .bindings li { display: grid; grid-template-columns: 1fr auto auto auto; align-items: center; gap: var(--sp-2); padding: var(--sp-1) var(--sp-2); border: 1px solid var(--border); border-radius: 4px; font-size: 0.85rem; }
  .bindings li.conflict { border-color: #ff7b72; }
  .preset-buttons { display: flex; flex-wrap: wrap; gap: var(--sp-1); justify-content: flex-end; }
  .preview { display: flex; flex-direction: column; gap: var(--sp-1); margin-top: var(--sp-3); padding: var(--sp-3); border-radius: 4px; background: var(--terminal-bg); color: var(--terminal-fg); font-family: "LiterationMono Nerd Font Mono", monospace; }
  .prompt { color: var(--terminal-cursor); }
  .green { color: #7ee787; }
  .yellow { color: #d29922; background: var(--terminal-selection); width: fit-content; }
  .cursor { width: 0.6ch; background: var(--terminal-cursor); }
  .color-grid { display: grid; grid-template-columns: repeat(4, minmax(130px, 1fr)); gap: var(--sp-2); margin-top: var(--sp-2); }
  .font-size { grid-template-columns: 1fr auto auto; width: fit-content; margin-top: var(--sp-2); }
  .font-size input { grid-row: auto; width: 4.5rem; height: auto; padding: var(--sp-1); border: 1px solid var(--border); color: var(--fg); background: var(--bg); }
  label { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: var(--sp-1); padding: var(--sp-2); border: 1px solid var(--border); border-radius: 4px; color: var(--fg-dim); font-size: 0.8rem; }
  input { grid-row: span 2; width: 34px; height: 30px; padding: 0; border: none; background: transparent; cursor: pointer; }
  code { color: var(--fg); font-size: 0.72rem; }
  .actions { margin-top: var(--sp-4); }
  .save { background: var(--accent); border-color: var(--accent); color: #fff; }
  @media (max-width: 700px) { .settings-page { padding: var(--sp-3); } header, .card-heading { align-items: flex-start; flex-direction: column; } .preset-buttons { justify-content: flex-start; } .color-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
