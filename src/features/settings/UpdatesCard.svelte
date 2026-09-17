<script lang="ts">
  import { appUpdateStatusText, installableUpdateVersion, updateChannelDescription, updateChannelLabel, type AppUpdateState, type UpdateChannel } from "../../registry/appUpdate";

  interface Props {
    update: AppUpdateState;
    onCheck: () => void;
    onInstall: () => void;
    onSelectChannel: (channel: UpdateChannel) => void;
  }

  let { update, onCheck, onInstall, onSelectChannel }: Props = $props();

  const channels: UpdateChannel[] = ["stable", "rc"];

  let busy = $derived(update.status.phase === "checking" || update.status.phase === "installing");
  let installableVersion = $derived(installableUpdateVersion(update.status));
</script>

<section class="settings-card">
  <div class="card-heading">
    <div>
      <h2>Updates</h2>
      <p>{update.currentVersion ? `Choux ${update.currentVersion}. ` : ""}New releases come from GitHub and install only when you choose to.</p>
    </div>
    <div class="actions">
      <button type="button" disabled={busy} onclick={onCheck}>Check for updates</button>
      {#if installableVersion}
        <button type="button" class="install" disabled={busy} onclick={onInstall}>Install {installableVersion} and restart</button>
      {/if}
    </div>
  </div>

  <label class="channel">
    <span>Channel</span>
    <select value={update.channel} disabled={busy} onchange={(event) => onSelectChannel(event.currentTarget.value as UpdateChannel)}>
      {#each channels as channel (channel)}
        <option value={channel}>{updateChannelLabel(channel)}</option>
      {/each}
    </select>
  </label>
  <p class="hint">{updateChannelDescription(update.channel)}</p>

  <p class="status" class:failed={update.status.phase === "failed"} role="status">{appUpdateStatusText(update.status)}</p>
</section>

<style>
  .settings-card { padding: var(--sp-4); border: 1px solid var(--border); border-radius: 6px; background: var(--bg-elevated); }
  .card-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-3); }
  .card-heading > div:first-child { flex: 1 1 16rem; min-width: 0; }
  .actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
  h2, p { margin: 0; }
  h2 { font-size: 1rem; }
  p { color: var(--fg-dim); font-size: 0.85rem; }
  button { padding: var(--sp-1) var(--sp-3); border: 1px solid var(--border); border-radius: 3px; background: var(--bg); color: var(--fg); font: inherit; cursor: pointer; }
  button:hover { border-color: var(--fg-dim); }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .install { border-color: var(--accent); }
  .channel { display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--sp-3); font-size: 0.85rem; }
  .channel select { padding: var(--sp-1) var(--sp-2); border: 1px solid var(--border); border-radius: 3px; background: var(--bg); color: var(--fg); font: inherit; }
  .channel select:disabled { opacity: 0.45; cursor: not-allowed; }
  .hint { margin-top: var(--sp-1); }
  .status { margin-top: var(--sp-3); }
  .status.failed { color: var(--status-offline); }
</style>
