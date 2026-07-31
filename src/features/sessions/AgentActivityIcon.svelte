<script lang="ts">
  import type { AgentActivity } from "../../registry/types";

  interface Props {
    activity: AgentActivity;
    label: string;
  }

  let { activity, label }: Props = $props();
</script>

<svg class="icon {activity}" viewBox="0 0 16 16" width="12" height="12" role="img" aria-label={label}>
  {#if activity === "waiting"}
    <circle class="pulse" cx="8" cy="8" r="7" />
    <path d="M8 4.5v4.2" />
    <circle class="dot" cx="8" cy="11.6" r="0.9" />
  {:else if activity === "compacting"}
    <path d="M2.5 8h11" />
    <path d="M6 4.5 2.5 8 6 11.5" />
    <path d="M10 4.5 13.5 8 10 11.5" />
  {:else if activity === "idle"}
    <circle cx="8" cy="8" r="6" />
  {:else}
    <circle class="track" cx="8" cy="8" r="6" />
    <path class="spin" d="M8 2a6 6 0 0 1 6 6" />
  {/if}
</svg>

<style>
  .icon {
    flex: 0 0 auto;
    align-self: center;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    overflow: visible;
  }

  .idle {
    color: var(--fg-dim);
    opacity: 0.7;
  }

  .busy,
  .tool,
  .compacting {
    color: var(--status-online);
  }

  .waiting {
    color: var(--status-warn);
  }

  .track {
    opacity: 0.25;
  }

  .dot {
    fill: currentColor;
    stroke: none;
  }

  .spin {
    transform-origin: 8px 8px;
    animation: spin 1.1s linear infinite;
  }

  .pulse {
    opacity: 0.45;
    transform-origin: 8px 8px;
    animation: pulse 1.6s ease-in-out infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @keyframes pulse {
    50% { opacity: 1; transform: scale(1.12); }
  }

  @media (prefers-reduced-motion: reduce) {
    .spin,
    .pulse {
      animation: none;
    }

    .pulse {
      opacity: 0.8;
    }
  }
</style>