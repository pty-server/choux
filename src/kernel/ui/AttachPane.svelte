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
  import { isTauriRuntime } from "../storage/tokenStore";
  import { localPtysSocket } from "../transport/localPtys";

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
    layoutRevision?: number;
    onDims?: (dims: { cols: number; rows: number }) => void;
    onConnectionState?: (state: "attaching" | "online" | "reconnecting" | "offline" | "exited") => void;
    onProtocolMismatch?: (serverProtocol: number) => void;
  }

  let { baseUrl, localInstance, token, sessionId, serverId, readonly, lossy, theme, fontSize, layoutRevision, onDims, onConnectionState, onProtocolMismatch }: Props = $props();

  let container: HTMLDivElement | undefined = $state(undefined);
  let terminal: Terminal | undefined = $state(undefined);
  let requestResize = $state<(() => void) | undefined>(undefined);

  let cols = $state(0);
  let rows = $state(0);
  let exitInfo = $state<AttachExitInfo | undefined>(undefined);
  let status = $state<import("../transport/attach").AttachStatus>("online");
  let connectionState = $derived<"attaching" | "online" | "reconnecting" | "offline" | "exited">(
    exitInfo ? "exited" : cols === 0 ? "attaching" : status,
  );

  function openTerminalUrl(uri: string): void {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;

    if (isTauriRuntime()) {
      void import("@tauri-apps/plugin-opener")
        .then(({ openUrl }) => openUrl(url))
        // Failing to open a link must not interrupt the terminal session.
        .catch(() => {});
      return;
    }

    window.open(url, "_blank", "noopener,noreferrer");
  }

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
    term.loadAddon(new WebLinksAddon((_event, uri) => openTerminalUrl(uri)));
    term.unicode.activeVersion = "11";

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

<!-- Session details live in the status bar (Shell.svelte) to avoid duplicating
     them in the terminal pane. -->
<div class="pane" style:background={theme.background}>
  <div class="container">
    <div class="terminal-container" bind:this={container}></div>
  </div>
</div>

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
</style>
