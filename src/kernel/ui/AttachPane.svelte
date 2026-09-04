<script lang="ts">
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { ImageAddon } from "@xterm/addon-image";
  import { Unicode11Addon } from "@xterm/addon-unicode11";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import "@xterm/xterm/css/xterm.css";
  import { PROTOCOL_VERSION } from "@pty-server/protocol";
  import { AttachController } from "../transport/attach";
  import type { AttachExitInfo } from "../transport/attach";
  import { untrack } from "svelte";
  import type { TerminalTheme } from "../../registry/terminalTheme";
  import { localPtysSocket } from "../transport/localPtys";
  import { readClipboardText, writeClipboardText } from "../platform/clipboard";
  import { openExternalUrl } from "../platform/openUrl";
  import {
    clearActiveTerminalClipboard,
    decodeOsc52,
    needsMultilinePasteConfirm,
    setActiveTerminalClipboard,
    type TerminalClipboardTarget,
  } from "./terminalClipboard";

  const bundledTerminalFont = "LiterationMono Nerd Font Mono";

  function terminalFontFamily(): string {
    const declared = getComputedStyle(document.documentElement)
      .getPropertyValue("--font-terminal")
      .trim();
    return declared || `'${bundledTerminalFont}', monospace`;
  }

  interface Props {
    baseUrl: string;
    localInstance?: string;
    token?: string;
    sessionId: string;
    serverId?: string;
    readonly?: boolean;
    lossy?: boolean;
    theme: TerminalTheme;
    fontSize: number;
    copyOnSelect?: boolean;
    layoutRevision?: number;
    onDims?: (dims: { cols: number; rows: number }) => void;
    onConnectionState?: (state: "attaching" | "online" | "reconnecting" | "offline" | "exited") => void;
    onProtocolMismatch?: (serverProtocol: number) => void;
  }

  let { baseUrl, localInstance, token, sessionId, serverId, readonly, lossy, theme, fontSize, copyOnSelect = false, layoutRevision, onDims, onConnectionState, onProtocolMismatch }: Props = $props();

  let container: HTMLDivElement | undefined = $state(undefined);
  let terminal: Terminal | undefined = $state(undefined);
  let requestResize = $state<(() => void) | undefined>(undefined);
  let contextMenu = $state<{ x: number; y: number; hasSelection: boolean } | undefined>(undefined);
  let pendingPaste = $state<string | undefined>(undefined);

  let cols = $state(0);
  let rows = $state(0);
  let exitInfo = $state<AttachExitInfo | undefined>(undefined);
  let status = $state<import("../transport/attach").AttachStatus>("online");
  let connectionState = $derived<"attaching" | "online" | "reconnecting" | "offline" | "exited">(
    exitInfo ? "exited" : cols === 0 ? "attaching" : status,
  );


  const nativePasteWindowMs = 300;
  let lastNativePasteAt = 0;

  async function copySelection(): Promise<boolean> {
    const text = terminal?.getSelection();
    if (!text) return false;
    try {
      await writeClipboardText(text);
      return true;
    } catch {
      return false;
    }
  }

  function writeToTerminal(text: string): void {
    terminal?.paste(text);
    terminal?.focus();
  }

  function applyPaste(text: string): void {
    if (!terminal || readonly || text.length === 0) return;
    if (needsMultilinePasteConfirm(text, terminal.modes.bracketedPasteMode)) {
      pendingPaste = text;
      return;
    }
    writeToTerminal(text);
  }

  async function pasteFromClipboard(): Promise<void> {
    if (readonly) return;
    try {
      applyPaste(await readClipboardText());
    } catch {
      // No clipboard permission or an empty clipboard - nothing to paste.
    }
  }

  function pasteFromSelection(): void {
    const selection = terminal?.getSelection();
    if (selection) applyPaste(selection);
    else void pasteFromClipboard();
  }

  function confirmPendingPaste(): void {
    const text = pendingPaste;
    pendingPaste = undefined;
    if (text !== undefined) writeToTerminal(text);
  }

  function appGrabsMouse(event: MouseEvent): boolean {
    // xterm itself lets Shift bypass mouse reporting, so Shift always means
    // "this gesture is for Choux, not for the program in the pty".
    return !event.shiftKey && terminal !== undefined && terminal.modes.mouseTrackingMode !== "none";
  }

  function handleContextMenu(event: MouseEvent): void {
    event.preventDefault();
    if (appGrabsMouse(event)) {
      contextMenu = undefined;
      return;
    }
    contextMenu = {
      x: Math.min(event.clientX, window.innerWidth - 176),
      y: Math.min(event.clientY, window.innerHeight - 128),
      hasSelection: terminal?.hasSelection() ?? false,
    };
  }

  // Native pastes (Ctrl+V, middle click) go through the same path as Choux's
  // own, so the multi-line guard cannot be sidestepped by the gesture used.
  function handlePaste(event: ClipboardEvent): void {
    lastNativePasteAt = Date.now();
    const text = event.clipboardData?.getData("text/plain");
    if (text === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    applyPaste(text);
  }

  function handleMouseUp(): void {
    if (copyOnSelect && terminal?.hasSelection()) void copySelection();
  }

  function handleAuxClick(event: MouseEvent): void {
    if (event.button !== 1 || readonly || appGrabsMouse(event)) return;
    // WebKitGTK pastes the X11 primary selection into xterm's textarea on its
    // own - before or shortly after this click. Only step in when it did not.
    window.setTimeout(() => {
      if (Date.now() - lastNativePasteAt > nativePasteWindowMs) pasteFromSelection();
    }, 60);
  }

  function runMenuCommand(action: () => void): void {
    contextMenu = undefined;
    action();
  }

  $effect(() => {
    if (!terminal) return;
    const target: TerminalClipboardTarget = {
      copySelection,
      paste: pasteFromClipboard,
      selectAll: () => terminal?.selectAll(),
    };
    setActiveTerminalClipboard(target);
    return () => clearActiveTerminalClipboard(target);
  });

  $effect(() => {
    onDims?.({ cols, rows });
    onConnectionState?.(connectionState);
  });

  $effect(() => {
    if (terminal) terminal.options.theme = theme;
  });

  $effect(() => {
    if (!terminal) return;
    terminal.options.fontSize = fontSize;
    const frame = requestAnimationFrame(() => requestResize?.());
    return () => cancelAnimationFrame(frame);
  });

  // Shell chrome changes do not emit a browser resize event.  Re-measure on
  // those changes after the layout has settled, in addition to observing the
  // container for ordinary size changes.
  $effect(() => {
    void layoutRevision;
    if (!requestResize) return;
    const frame = requestAnimationFrame(requestResize);
    return () => cancelAnimationFrame(frame);
  });

  // Single effect: opening the terminal into the DOM, measuring it with
  // FitAddon, and opening the attach socket all have to happen in that
  // order, against the same `container` element - splitting this across
  // effects with independent dependencies risks fitting/opening before the
  // container exists. `container` is only set once (via `bind:this`), so
  // this effect body runs once per mount.
  $effect(() => {
    if (!container) return;

    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: terminalFontFamily(),
      fontSize: untrack(() => fontSize),
      theme: untrack(() => theme),
    });
    terminal = term;
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new Unicode11Addon());
    // Render image protocols without changing the terminal's window-size
    // report behavior; TUI applications already manage those queries.
    term.loadAddon(new ImageAddon({ enableSizeReports: false }));
    term.loadAddon(new WebLinksAddon((_event, uri) => openExternalUrl(uri)));
    term.unicode.activeVersion = "11";

    // OSC 52 is what makes copying work without a mouse: tmux `set-clipboard on`
    // and TUI applications send yanked text here. Reads are never answered.
    term.parser.registerOscHandler(52, (data) => {
      const text = decodeOsc52(data);
      if (text !== undefined) void writeClipboardText(text).catch(() => {});
      return true;
    });

    let disposed = false;
    let controller: AttachController | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let lastRequested: { cols: number; rows: number } | undefined;

    // xterm measures the character cell (and caches it for the block cursor)
    // the moment it opens. If the terminal font is still swapping in via
    // `font-display: swap`, that measurement happens against the fallback
    // font, leaving the cursor mismatched against the real glyphs. Wait for
    // the terminal font to actually be loaded before opening/fitting.
    const loadedFontSize = term.options.fontSize ?? 15;
    const waitForFont = async () => {
      try {
        await Promise.all([
          document.fonts.load(`${loadedFontSize}px "${bundledTerminalFont}"`),
          document.fonts.load(`bold ${loadedFontSize}px "${bundledTerminalFont}"`),
        ]);
        await document.fonts.ready;
      } catch {
        // Font Loading API unavailable or the load failed - fall back to
        // opening immediately rather than blocking the terminal forever.
      }
    };

    waitForFont().then(() => {
      if (disposed || !container) return;

      term.open(container);
      fitAddon.fit();
      lastRequested = { cols: term.cols, rows: term.rows };

      controller = new AttachController({
        baseUrl,
        sessionId,
        serverId,
        token,
        cols: term.cols,
        rows: term.rows,
        readonly,
        lossy,
        clientProtocolVersion: PROTOCOL_VERSION,
        terminal: term,
        createSocket: (url, protocols) => {
          if (localInstance) {
            const target = new URL(url);
            return localPtysSocket(localInstance, `${target.pathname}${target.search}`, protocols);
          }
          return new WebSocket(url, protocols);
        },
        onReady: (dims) => {
          cols = dims.cols;
          rows = dims.rows;
        },
        onResized: (dims) => {
          cols = dims.cols;
          rows = dims.rows;
        },
        onProtocolMismatch,
        onExit: (info) => {
          exitInfo = info;
        },
        onStatus: (s) => {
          status = s;
        },
      });

      requestResize = () => {
        if (!controller) return;
        const proposed = fitAddon.proposeDimensions();
        if (
          !proposed ||
          (proposed.cols === lastRequested?.cols && proposed.rows === lastRequested?.rows)
        ) return;

        lastRequested = proposed;
        controller?.resize(proposed.cols, proposed.rows);
      };
      resizeObserver = new ResizeObserver(requestResize);
      resizeObserver.observe(container);
    });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      requestResize = undefined;
      controller?.close();
      terminal = undefined;
      term.dispose();
    };
  });
</script>

<svelte:window
  onclick={() => contextMenu = undefined}
  onkeydown={(event) => { if (event.key === "Escape") contextMenu = undefined; }}
/>

<!-- Session details live in the status bar (Shell.svelte) to avoid duplicating
     them in the terminal pane. -->
<div class="pane" style:background={theme.background}>
  <div class="container">
    <div
      class="terminal-container"
      bind:this={container}
      oncontextmenu={handleContextMenu}
      onauxclick={handleAuxClick}
      onmouseup={handleMouseUp}
      onpastecapture={handlePaste}
    ></div>
  </div>
</div>

{#if contextMenu}
  <div class="context-menu" role="menu" tabindex="-1" style={`left: ${contextMenu.x}px; top: ${contextMenu.y}px`}>
    <button
      type="button"
      role="menuitem"
      disabled={!contextMenu.hasSelection}
      onclick={() => runMenuCommand(() => void copySelection())}
    >Copy</button>
    <button
      type="button"
      role="menuitem"
      disabled={readonly}
      onclick={() => runMenuCommand(() => void pasteFromClipboard())}
    >Paste</button>
    <button
      type="button"
      role="menuitem"
      onclick={() => runMenuCommand(() => terminal?.selectAll())}
    >Select all</button>
    <button
      type="button"
      role="menuitem"
      disabled={!contextMenu.hasSelection}
      onclick={() => runMenuCommand(() => terminal?.clearSelection())}
    >Clear selection</button>
  </div>
{/if}

{#if pendingPaste !== undefined}
  <div
    class="overlay"
    role="presentation"
    onclick={() => pendingPaste = undefined}
    onkeydown={(event) => { if (event.key === "Escape") pendingPaste = undefined; }}
  >
    <div
      class="dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="paste-warning-title"
      tabindex="-1"
      onclick={(event) => event.stopPropagation()}
      onkeydown={(event) => { if (event.key === "Escape") pendingPaste = undefined; }}
    >
      <h2 id="paste-warning-title">Paste {pendingPaste.split("\n").length} lines?</h2>
      <p>Bracketed paste is off in this session, so every line runs as soon as it lands.</p>
      <pre>{pendingPaste.length > 400 ? `${pendingPaste.slice(0, 400)}…` : pendingPaste}</pre>
      <div class="actions">
        <button type="button" onclick={() => pendingPaste = undefined}>Cancel</button>
        <button type="button" class="confirm" onclick={confirmPendingPaste}>Paste</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .pane {
    width: 100%;
    height: 100%;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background: #000;
    box-sizing: border-box;
  }

  .container {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    overflow: hidden;
  }

  .terminal-container {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: grid;
    overflow: hidden;
    margin-top: var(--sp-2);
  }

  .terminal-container :global(.xterm) {
    margin: auto;
  }

  .context-menu {
    position: fixed;
    z-index: 200;
    min-width: 170px;
    padding: var(--sp-1);
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-elevated);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.24);
  }

  .context-menu button {
    width: 100%;
    padding: var(--sp-2);
    border: none;
    border-radius: 2px;
    background: none;
    color: var(--fg);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .context-menu button:disabled {
    color: var(--fg-dim);
    cursor: default;
  }

  .context-menu button:hover:not(:disabled),
  .context-menu button:focus-visible:not(:disabled) {
    background: var(--bg);
  }

  .overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.5);
  }

  .dialog {
    min-width: 360px;
    max-width: 90vw;
    padding: var(--sp-4);
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-elevated);
    color: var(--fg);
  }

  .dialog h2 {
    margin-bottom: var(--sp-2);
    font-size: 1rem;
  }

  .dialog p {
    margin-bottom: var(--sp-3);
    color: var(--fg-dim);
  }

  .dialog pre {
    max-height: 30vh;
    padding: var(--sp-2);
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
    font-family: var(--font-terminal, monospace);
    font-size: 0.85rem;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-2);
    margin-top: var(--sp-3);
  }

  .actions button {
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
    color: var(--fg);
    font: inherit;
    cursor: pointer;
  }

  .actions button.confirm {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--bg);
  }
</style>
