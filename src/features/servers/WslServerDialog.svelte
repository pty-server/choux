<script lang="ts">
  import { distroLabel, usableDistro, type WslProbe, type WslStatus } from "../../registry/wsl";
  import { wslDialogStage } from "./wslDialog";

  interface Props {
    open: boolean;
    status: WslStatus | undefined;
    distro: string | undefined;
    user: string;
    probe: WslProbe | undefined;
    busy?: boolean;
    message?: string;
    onSelectDistro: (name: string) => void;
    onUserInput: (user: string) => void;
    onCheck: () => void;
    onInstall: () => void;
    onStart: () => void;
    onRetry: () => void;
    onClose: () => void;
  }

  let { open, status, distro, user, probe, busy = false, message, onSelectDistro, onUserInput, onCheck, onInstall, onStart, onRetry, onClose }: Props = $props();
  let stage = $derived(wslDialogStage(status, distro, probe));
</script>

{#if open}
  <div class="overlay" role="presentation" onclick={onClose} onkeydown={(event) => event.key === "Escape" && onClose()}>
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="wsl-server-title" tabindex="-1" onclick={(event) => event.stopPropagation()} onkeydown={(event) => event.stopPropagation()}>
      <h2 id="wsl-server-title">Run ptys in WSL</h2>
      {#if stage.kind === "loading"}
        <p>Looking for WSL distributions...</p>
      {:else if stage.kind === "problem"}
        <p>{stage.problem}</p>
      {:else if stage.kind === "no-distros"}
        <p>No WSL distribution is installed. Install one with <code>wsl --install</code>, then retry.</p>
      {:else}
        <p>Choux runs ptys inside a WSL distribution and connects to it through <code>wsl.exe</code>.</p>
        <label>
          Distribution
          <select value={stage.distro.name} disabled={busy} onchange={(event) => onSelectDistro(event.currentTarget.value)}>
            {#each status?.distros ?? [] as candidate (candidate.name)}
              <option value={candidate.name} disabled={!usableDistro(candidate)}>{distroLabel(candidate)}</option>
            {/each}
          </select>
        </label>
        <label>
          Linux user
          <input type="text" value={user} placeholder="Default user" disabled={busy} oninput={(event) => onUserInput(event.currentTarget.value)} />
        </label>
        {#if stage.kind === "wsl1"}
          <p>{stage.distro.name} runs on WSL 1, which Choux does not support. Convert it with <code>wsl --set-version {stage.distro.name} 2</code>.</p>
        {:else if stage.kind === "unchecked"}
          <p>Choux checks {stage.distro.name} for Node.js and ptys.{#if !stage.distro.running} This starts the distribution, which can take a few seconds.{/if}</p>
        {:else if stage.kind === "no-node"}
          <p>{stage.message}</p>
          <p>Open it with <code>wsl.exe -d {stage.distro.name}</code>, install Node.js there (for example with nvm), then check again.</p>
        {:else if stage.kind === "install"}
          <p>ptys is not installed in {stage.distro.name}. Choux can install it with npm.</p>
          {#if probe?.message}<p>{probe.message}</p>{/if}
        {:else if stage.kind === "no-ptys"}
          <p>{stage.message}</p>
        {:else if stage.kind === "ready"}
          <p>ptys {stage.ptysVersion} is installed in {stage.distro.name}. Choux starts a daemon there and connects through <code>ptys bridge</code>.</p>
        {/if}
      {/if}
      {#if message}<p class="message" role="alert">{message}</p>{/if}
      <div class="actions">
        <button type="button" onclick={onClose} disabled={busy}>Not now</button>
        {#if stage.kind === "problem" || stage.kind === "no-distros"}
          <button type="button" class="primary" onclick={onRetry} disabled={busy}>Retry</button>
        {:else if stage.kind === "unchecked"}
          <button type="button" class="primary" onclick={onCheck} disabled={busy}>Check {stage.distro.name}</button>
        {:else if stage.kind === "no-node" || stage.kind === "no-ptys"}
          <button type="button" class="primary" onclick={onCheck} disabled={busy}>Check again</button>
        {:else if stage.kind === "install"}
          <button type="button" onclick={onCheck} disabled={busy}>Check again</button>
          <button type="button" class="primary" onclick={onInstall} disabled={busy}>Install ptys from npm</button>
        {:else if stage.kind === "ready"}
          <button type="button" onclick={onCheck} disabled={busy}>Check again</button>
          <button type="button" class="primary" onclick={onStart} disabled={busy}>Start in WSL ({stage.distro.name})</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay { position: fixed; inset: 0; z-index: 120; display: grid; place-items: center; background: rgba(0, 0, 0, 0.55); }
  .dialog { width: min(480px, calc(100vw - 2rem)); display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); color: var(--fg); background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 6px; }
  h2, p { margin: 0; }
  p { color: var(--fg-dim); line-height: 1.45; }
  code { padding: var(--sp-1); color: var(--fg); background: var(--bg); border-radius: 3px; overflow-wrap: anywhere; }
  label { display: flex; flex-direction: column; gap: var(--sp-1); color: var(--fg-dim); font-size: 0.85rem; }
  input, select { padding: var(--sp-1) var(--sp-2); color: var(--fg); background: var(--bg); border: 1px solid var(--border); border-radius: 3px; font-size: 0.85rem; }
  input:focus, select:focus { outline: none; border-color: var(--accent); }
  .message { color: var(--status-warn); }
  .actions { display: flex; justify-content: flex-end; gap: var(--sp-2); flex-wrap: wrap; }
  button { padding: var(--sp-1) var(--sp-3); color: var(--fg-dim); background: var(--bg); border: 1px solid var(--border); border-radius: 3px; cursor: pointer; }
  button.primary { color: #fff; background: var(--accent); border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: wait; }
</style>
