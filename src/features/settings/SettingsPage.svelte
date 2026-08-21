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
  import { eventSettingsEqual, type EventSettings } from "../../registry/eventSettings";
  import {
    bindableCommands,
    conflictingCommandIds,
    resolveKeybindings,
    type KeybindingOverrides,
  } from "../../registry/keybindings";
  import {
    emptyProfileDraft,
    fromProfileDrafts,
    normalizeSessionProfiles,
    sessionProfileDraftError,
    sessionProfilesEqual,
    toProfileDrafts,
    type SessionProfileDraft,
    type SessionProfiles,
  } from "../../registry/sessionProfiles";

  interface Props {
    settings: TerminalSettings;
    onSave: (settings: TerminalSettings) => Promise<void>;
    onClose: () => void;
    globalShortcut: GlobalShortcutSettings;
    globalShortcutSupported: boolean;
    onSaveGlobalShortcut: (settings: GlobalShortcutSettings) => Promise<string | undefined>;
    eventSettings: EventSettings;
    onSaveEventSettings: (settings: EventSettings) => Promise<void>;
    keybindingOverrides: KeybindingOverrides;
    isMac: boolean;
    onSaveKeybindings: (overrides: KeybindingOverrides) => Promise<void>;
    sessionProfiles: SessionProfiles;
    onSaveSessionProfiles: (profiles: SessionProfiles) => Promise<void>;
    /** Injected because id generation lives in the kernel, which features cannot import. */
    newProfileId: () => string;
  }

  let {
    settings,
    onSave,
    onClose,
    globalShortcut,
    globalShortcutSupported,
    onSaveGlobalShortcut,
    eventSettings,
    onSaveEventSettings,
    keybindingOverrides,
    isMac,
    onSaveKeybindings,
    sessionProfiles,
    onSaveSessionProfiles,
    newProfileId,
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

  let eventDraft = $derived<EventSettings>({ ...eventSettings });
  let eventSaving = $state(false);

  async function saveEvents() {
    eventSaving = true;
    try {
      await onSaveEventSettings(eventDraft);
    } finally {
      eventSaving = false;
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

  let profileRows = $derived<SessionProfileDraft[]>(toProfileDrafts(sessionProfiles));
  let profileDefaultId = $derived(sessionProfiles.defaultProfileId ?? "");
  let profilesSaving = $state(false);

  let profileErrors = $derived(profileRows.map(sessionProfileDraftError));
  let profilesDraft = $derived(fromProfileDrafts(profileRows, profileDefaultId || undefined));

  function areProfilesDirty() {
    return !sessionProfilesEqual(profilesDraft, normalizeSessionProfiles(sessionProfiles));
  }

  function addProfile() {
    profileRows = [...profileRows, emptyProfileDraft(newProfileId())];
  }

  function updateProfile(index: number, patch: Partial<SessionProfileDraft>) {
    profileRows = profileRows.map((row, i) => (i === index ? { ...row, ...patch } : row));
  }

  function deleteProfile(index: number) {
    const removed = profileRows[index];
    profileRows = profileRows.filter((_, i) => i !== index);
    if (profileDefaultId === removed.id) profileDefaultId = "";
  }

  async function saveProfiles() {
    profilesSaving = true;
    try {
      await onSaveSessionProfiles(profilesDraft);
    } finally {
      profilesSaving = false;
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

  <div class="cards">
  <div class="card-column">
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
        <h2>Events</h2>
        <p>How Choux reacts to events sent by tools running inside a session.</p>
      </div>
      <button type="button" class="save" disabled={eventSettingsEqual(eventDraft, eventSettings) || eventSaving} onclick={() => void saveEvents()}>{eventSaving ? "Saving…" : "Save events"}</button>
    </div>

    <ul class="events">
      <li>
        <label class="toggle">
          <input type="checkbox" checked={eventDraft.handleQuestions} onchange={(event) => (eventDraft = { ...eventDraft, handleQuestions: event.currentTarget.checked })} />
          <span>Handle question requests</span>
        </label>
        <p>Show question dialogs sent by tools running in a session. When off, Choux declines them and the sender falls back to its own prompt.</p>
      </li>
      <li>
        <label class="toggle">
          <input type="checkbox" checked={eventDraft.revealWindow} onchange={(event) => (eventDraft = { ...eventDraft, revealWindow: event.currentTarget.checked })} />
          <span>Bring Choux to the front</span>
        </label>
        <p>Reveals and focuses the Choux window when something in a session needs a decision.</p>
      </li>
      <li>
        <label class="toggle">
          <input type="checkbox" checked={eventDraft.followAttention} onchange={(event) => (eventDraft = { ...eventDraft, followAttention: event.currentTarget.checked })} />
          <span>Follow sessions asking for input</span>
        </label>
        <p>Selects the session that needs a decision, and switches to its tmux window.</p>
      </li>
    </ul>
  </section>
  </div>

  <div class="card-column">
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
  </div>
  </div>

  <section class="settings-card profiles-card">
    <div class="card-heading">
      <div>
        <h2>Session profiles</h2>
        <p>Reusable commands for new sessions - each one gets a command palette entry. Sessions still start in the selected workspace.</p>
      </div>
      <div class="profile-actions">
        <button type="button" onclick={addProfile}>Add profile</button>
        <button type="button" class="save" disabled={!areProfilesDirty() || profilesSaving || profileErrors.some(Boolean)} onclick={() => void saveProfiles()}>{profilesSaving ? "Saving…" : "Save profiles"}</button>
      </div>
    </div>

    <ul class="profiles">
      <li class="profile-fallback">
        <label class="pick-default">
          <input type="radio" name="default-session-profile" checked={profileDefaultId === ""} onchange={() => (profileDefaultId = "")} />
          <span>Ask the server for its default shell</span>
        </label>
      </li>
      {#each profileRows as row, index (row.id)}
        <li class:invalid={profileErrors[index] !== undefined}>
          <div class="profile-top">
            <label class="pick-default">
              <input type="radio" name="default-session-profile" checked={profileDefaultId === row.id} onchange={() => (profileDefaultId = row.id)} />
              <span>Default</span>
            </label>
            <button type="button" onclick={() => deleteProfile(index)}>Delete</button>
          </div>
          <div class="profile-fields">
            <label>
              <span>Name</span>
              <input type="text" value={row.name} oninput={(event) => updateProfile(index, { name: event.currentTarget.value })} placeholder="e.g. tmux" />
            </label>
            <label>
              <span>Command</span>
              <input type="text" value={row.cmd} oninput={(event) => updateProfile(index, { cmd: event.currentTarget.value })} placeholder="Default shell" />
            </label>
            <label>
              <span>Args</span>
              <input type="text" value={row.argsText} oninput={(event) => updateProfile(index, { argsText: event.currentTarget.value })} placeholder="new-session -A -s main" />
            </label>
            <label class="profile-env">
              <span>Environment</span>
              <textarea rows="2" value={row.envText} oninput={(event) => updateProfile(index, { envText: event.currentTarget.value })} placeholder="KEY=value, one per line"></textarea>
            </label>
          </div>
          {#if profileErrors[index]}
            <p class="shortcut-error" role="alert">{profileErrors[index]}</p>
          {/if}
        </li>
      {/each}
    </ul>

    {#if profileRows.length === 0}
      <p>No profiles yet. Add one to get a palette entry and an optional default for New session.</p>
    {:else}
      <p>Args accept quotes for values with spaces. Environment variables are added on top of the server's.</p>
    {/if}
  </section>

  <section class="settings-card colors-card">
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
  .settings-page {
    display: flex; flex-direction: column; gap: var(--sp-4);
    box-sizing: border-box; width: 100%; height: 100%; padding: 0 var(--sp-4) var(--sp-4); overflow: auto;
  }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(440px, 1fr)); gap: var(--sp-4); }
  .card-column { display: flex; flex-direction: column; gap: var(--sp-4); }
  .card-column > .settings-card:last-child { flex: 1 1 auto; }
  header, .card-heading, .actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-3); }
  header {
    position: sticky; top: 0; z-index: 2;
    margin: 0 calc(-1 * var(--sp-4));
    padding: var(--sp-4);
    border-bottom: 1px solid var(--border);
    background: var(--bg);
  }
  .card-heading > div:first-child { flex: 1 1 16rem; min-width: 0; }
  .card-heading > .save, .card-heading > .profile-actions { flex: 0 0 auto; }
  h1, h2, h3, p { margin: 0; }
  h1 { font-size: 1.15rem; }
  h2 { font-size: 1rem; }
  h3 { margin-top: var(--sp-4); font-size: 0.9rem; }
  p { color: var(--fg-dim); font-size: 0.85rem; }
  button { padding: var(--sp-1) var(--sp-3); border: 1px solid var(--border); border-radius: 3px; background: var(--bg); color: var(--fg); cursor: pointer; }
  button:hover { border-color: var(--fg-dim); }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .settings-card { padding: var(--sp-4); border: 1px solid var(--border); border-radius: 6px; background: var(--bg-elevated); }
  .shortcut-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-top: var(--sp-3); }
  .toggle { grid-template-columns: auto auto; padding: var(--sp-1) var(--sp-2); }
  .toggle input { grid-row: auto; width: auto; height: auto; }
  .capture { flex: 1 1 12rem; min-width: 0; font-family: var(--font-terminal); }
  .capture.capturing { border-color: var(--accent); color: var(--accent); }
  .shortcut-error { margin-top: var(--sp-2); color: #ff7b72; font-size: 0.85rem; }
  .bindings { display: flex; flex-direction: column; gap: var(--sp-1); margin: var(--sp-3) 0 0; padding: 0; list-style: none; }
  .bindings li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); padding: var(--sp-1) var(--sp-2); border: 1px solid var(--border); border-radius: 4px; font-size: 0.85rem; }
  .bindings li > span { flex: 1 1 10rem; min-width: 0; }
  .bindings li.conflict { border-color: #ff7b72; }
  .events { display: flex; flex-direction: column; gap: var(--sp-2); margin: var(--sp-3) 0 0; padding: 0; list-style: none; }
  .events li { padding: var(--sp-2); border: 1px solid var(--border); border-radius: 4px; font-size: 0.85rem; }
  .events p { margin: var(--sp-1) 0 0; }
  .profile-actions { display: flex; gap: var(--sp-1); }
  .profiles { display: flex; flex-direction: column; gap: var(--sp-2); margin: var(--sp-3) 0 var(--sp-3); padding: 0; list-style: none; }
  .profiles li { padding: var(--sp-2); border: 1px solid var(--border); border-radius: 4px; font-size: 0.85rem; }
  .profiles li.invalid { border-color: #ff7b72; }
  .profiles .profile-fallback { padding: var(--sp-1) var(--sp-2); }
  .profile-top { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
  .profile-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--sp-2); margin-top: var(--sp-2); }
  .profile-env { grid-column: 1 / -1; }
  /* The bare `label`/`input` rules below are sized for color swatches. */
  .profiles label { grid-template-columns: 1fr; align-items: stretch; }
  .profiles .pick-default { display: flex; align-items: center; gap: var(--sp-1); padding: 0; border: none; }
  .profiles input[type="radio"] { grid-row: auto; width: auto; height: auto; }
  .profiles input[type="text"], .profiles textarea {
    grid-row: auto; width: 100%; height: auto; box-sizing: border-box;
    padding: var(--sp-1); border: 1px solid var(--border); border-radius: 3px;
    background: var(--bg); color: var(--fg); font: inherit; font-size: 0.85rem; cursor: auto;
  }
  .profiles textarea { resize: vertical; }
  .preset-buttons { display: flex; flex-wrap: wrap; gap: var(--sp-1); justify-content: flex-end; }
  .preview { display: flex; flex-direction: column; gap: var(--sp-1); margin-top: var(--sp-3); padding: var(--sp-3); border-radius: 4px; background: var(--terminal-bg); color: var(--terminal-fg); font-family: var(--font-terminal); }
  .prompt { color: var(--terminal-cursor); }
  .green { color: #7ee787; }
  .yellow { color: #d29922; background: var(--terminal-selection); width: fit-content; }
  .cursor { width: 0.6ch; background: var(--terminal-cursor); }
  .color-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--sp-2); margin-top: var(--sp-2); }
  .font-size { grid-template-columns: 1fr auto auto; width: fit-content; margin-top: var(--sp-2); }
  .font-size input { grid-row: auto; width: 4.5rem; height: auto; padding: var(--sp-1); border: 1px solid var(--border); color: var(--fg); background: var(--bg); }
  label { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: var(--sp-1); padding: var(--sp-2); border: 1px solid var(--border); border-radius: 4px; color: var(--fg-dim); font-size: 0.8rem; }
  input { grid-row: span 2; width: 34px; height: 30px; padding: 0; border: none; background: transparent; cursor: pointer; }
  code { color: var(--fg); font-size: 0.72rem; }
  .actions { margin-top: var(--sp-4); }
  .save { background: var(--accent); border-color: var(--accent); color: #fff; }
  @media (max-width: 700px) {
    .settings-page { padding: 0 var(--sp-3) var(--sp-3); }
    header { margin: 0 calc(-1 * var(--sp-3)); padding: var(--sp-3); }
    .cards { grid-template-columns: minmax(0, 1fr); }
    header, .card-heading { align-items: flex-start; flex-direction: column; }
    .preset-buttons { justify-content: flex-start; }
    .profile-fields { grid-template-columns: minmax(0, 1fr); }
  }
</style>
