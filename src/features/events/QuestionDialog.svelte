<script lang="ts">
  import SvelteDiff from "@humanspeak/svelte-diff";
  import type { PendingQuestion, QuestionResponseResult } from "../../registry/types";

  interface Props {
    question: PendingQuestion | undefined;
    onRespond: (id: string, response: { answer: string; note?: string } | { cancelled: true; note?: string }) => QuestionResponseResult;
  }

  let { question, onRespond }: Props = $props();
  let note = $state("");
  let error = $state("");
  let dialog = $state<HTMLDivElement>();
  let now = $state(Date.now());

  const showsDiff = $derived(question?.blocks.some((block) => block.kind === "diff") === true);
  const deadline = $derived(question?.expiresAt);
  const remainingMs = $derived(deadline === undefined ? undefined : Math.max(0, deadline - now));
  const remainingFraction = $derived(
    remainingMs === undefined || !question?.ttlMs ? 0 : remainingMs / question.ttlMs,
  );

  $effect(() => {
    if (deadline === undefined) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 250);
    return () => clearInterval(timer);
  });

  $effect(() => {
    if (!question) return;
    note = "";
    error = "";
  });

  $effect(() => {
    if (!question) return;
    dialog?.querySelector<HTMLButtonElement>(".option")?.focus();
  });

  function normalizedNote(): string | undefined {
    const value = note.trim();
    return value || undefined;
  }

  function respond(response: { answer: string } | { cancelled: true }): void {
    if (!question) return;
    const result = onRespond(question.id, { ...response, ...(normalizedNote() === undefined ? {} : { note: normalizedNote() }) });
    error = result.ok ? "" : result.error;
  }

  function handleOverlayKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    respond({ cancelled: true });
  }
</script>

{#if question}
  <div class="overlay" role="presentation" onclick={() => respond({ cancelled: true })} onkeydown={handleOverlayKeydown}>
    <div
      class="dialog"
      class:wide={showsDiff}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="question-title"
      aria-describedby="question-message"
      tabindex="-1"
      bind:this={dialog}
      onclick={(event) => event.stopPropagation()}
      onkeydown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}
    >
      {#if remainingMs !== undefined}
        <div class="countdown" role="timer" aria-label="Time left to answer">
          <div class="bar" style:width="{remainingFraction * 100}%"></div>
        </div>
      {/if}
      <div class="source">{question.serverLabel} · {question.sessionLabel}</div>
      <h2 id="question-title">{question.title || "Question"}</h2>
      <p id="question-message" class="message">{question.message}</p>
      {#if question.blocks.length > 0}
        <div class="blocks">
          {#each question.blocks as block, index (index)}
            <section class="block">
              {#if block.kind === "command"}
                <header>
                  <span class="kind">Command</span>
                  {#if block.cwd}<span class="cwd">{block.cwd}</span>{/if}
                  {#each block.badges ?? [] as badge (badge)}<span class="badge">{badge}</span>{/each}
                </header>
                <pre>{block.command}</pre>
              {:else if block.kind === "diff"}
                <header>
                  <span class="kind">{block.before.length === 0 ? "New content" : "Change"}</span>
                  {#if block.path}<span class="cwd">{block.path}</span>{/if}
                  {#each block.badges ?? [] as badge (badge)}<span class="badge">{badge}</span>{/each}
                </header>
                <div class="diff">
                  <SvelteDiff originalText={block.before} modifiedText={block.after} cleanupSemantic>
                    {#snippet remove(text: string)}<del>{text}</del>{/snippet}
                    {#snippet insert(text: string)}<ins>{text}</ins>{/snippet}
                    {#snippet lineBreak()}<br />{/snippet}
                  </SvelteDiff>
                </div>
              {:else}
                <header><span class="kind">{block.title || "Details"}</span></header>
                <dl>
                  {#each block.fields as field (field.label)}
                    <dt>{field.label}</dt>
                    <dd>{field.value}</dd>
                  {/each}
                </dl>
              {/if}
            </section>
          {/each}
        </div>
      {/if}
      <div class="options" aria-label="Answer options">
        {#each question.options as option (option.id)}
          <button type="button" class="option" onclick={() => respond({ answer: option.id })}>
            <span>{option.label}</span>
            {#if option.description}<small>{option.description}</small>{/if}
          </button>
        {/each}
      </div>
      {#if question.notes}
        <label>
          Add a note <span>(optional)</span>
          <textarea bind:value={note} rows="3" placeholder="Add context for the requester"></textarea>
        </label>
      {/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <div class="actions">
        {#if remainingMs !== undefined}
          <span class="remaining">{Math.ceil(remainingMs / 1000)}s left</span>
        {/if}
        <button type="button" class="cancel" onclick={() => respond({ cancelled: true })}>Cancel</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay { position: fixed; inset: 0; z-index: 200; display: grid; place-items: center; padding: var(--sp-4); background: rgba(0, 0, 0, 0.6); }
  .dialog { box-sizing: border-box; width: min(600px, 100%); max-height: calc(100dvh - 2rem); display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); color: var(--fg); background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35); overflow: hidden; }
  .dialog.wide { width: min(960px, 100%); }
  .source { color: var(--fg-dim); font-size: 0.75rem; overflow-wrap: anywhere; }
  h2, p { margin: 0; }
  h2 { font-size: 1rem; }
  .message { flex: 0 1 auto; min-height: 0; padding-right: var(--sp-1); white-space: pre-wrap; overflow-wrap: anywhere; overflow-y: auto; line-height: 1.45; }
  .blocks { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: var(--sp-2); overflow-y: auto; }
  .block { display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
  .block header { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-1) var(--sp-2); background: var(--bg-elevated); border-bottom: 1px solid var(--border); font-size: 0.7rem; }
  .kind { color: var(--fg-dim); text-transform: uppercase; letter-spacing: 0.06em; }
  .cwd { flex: 1 1 auto; min-width: 0; color: var(--fg-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge { flex: 0 0 auto; padding: 1px var(--sp-1); color: var(--status-offline); border: 1px solid currentColor; border-radius: 999px; }
  .block pre { margin: 0; padding: var(--sp-2); font: inherit; font-size: 0.85rem; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; }
  .diff { padding: var(--sp-2); font-size: 0.85rem; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; }
  del, ins { text-decoration: none; border-radius: 2px; }
  del { color: var(--status-offline); background: color-mix(in srgb, var(--status-offline) 18%, transparent); }
  ins { color: var(--status-online); background: color-mix(in srgb, var(--status-online) 18%, transparent); }
  dl { display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr); gap: var(--sp-1) var(--sp-3); margin: 0; padding: var(--sp-2); font-size: 0.85rem; }
  dt { color: var(--fg-dim); }
  dd { margin: 0; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; }
  .options { display: grid; gap: var(--sp-2); }
  .option { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: var(--sp-2) var(--sp-3); color: var(--fg); text-align: left; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; }
  .option:hover, .option:focus-visible { border-color: var(--accent); }
  small, label span { color: var(--fg-dim); }
  label { display: flex; flex-direction: column; gap: var(--sp-1); color: var(--fg); font-size: 0.85rem; }
  textarea { resize: vertical; padding: var(--sp-2); color: var(--fg); font: inherit; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; }
  textarea:focus { outline: none; border-color: var(--accent); }
  .countdown { height: 3px; margin: calc(var(--sp-4) * -1) calc(var(--sp-4) * -1) 0; background: var(--border); border-radius: 3px 3px 0 0; overflow: hidden; }
  .bar { height: 100%; background: var(--accent); transition: width 250ms linear; }
  .actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--sp-3); }
  .remaining { color: var(--fg-dim); font-size: 0.75rem; font-variant-numeric: tabular-nums; }
  .cancel { padding: var(--sp-1) var(--sp-3); color: var(--fg); background: var(--bg); border: 1px solid var(--border); border-radius: 3px; cursor: pointer; }
  .error { color: var(--status-offline); font-size: 0.85rem; }
</style>
