<script lang="ts">
  import type { PendingQuestion, QuestionResponseResult } from "../../registry/types";

  interface Props {
    question: PendingQuestion | undefined;
    onRespond: (id: string, response: { answer: string; note?: string } | { cancelled: true; note?: string }) => QuestionResponseResult;
  }

  let { question, onRespond }: Props = $props();
  let note = $state("");
  let error = $state("");
  let dialog = $state<HTMLDivElement>();

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
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="question-title"
      aria-describedby="question-message"
      tabindex="-1"
      bind:this={dialog}
      onclick={(event) => event.stopPropagation()}
      onkeydown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}
    >
      <div class="source">{question.serverLabel} · {question.sessionLabel}</div>
      <h2 id="question-title">{question.title || "Question"}</h2>
      <p id="question-message" class="message">{question.message}</p>
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
        <button type="button" class="cancel" onclick={() => respond({ cancelled: true })}>Cancel</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay { position: fixed; inset: 0; z-index: 200; display: grid; place-items: center; padding: var(--sp-4); background: rgba(0, 0, 0, 0.6); }
  .dialog { box-sizing: border-box; width: min(520px, 100%); max-height: calc(100dvh - 2rem); display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); color: var(--fg); background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35); overflow: hidden; }
  .source { color: var(--fg-dim); font-size: 0.75rem; overflow-wrap: anywhere; }
  h2, p { margin: 0; }
  h2 { font-size: 1rem; }
  .message { flex: 1 1 auto; min-height: 0; padding-right: var(--sp-1); white-space: pre-wrap; overflow-wrap: anywhere; overflow-y: auto; line-height: 1.45; }
  .options { display: grid; gap: var(--sp-2); }
  .option { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: var(--sp-2) var(--sp-3); color: var(--fg); text-align: left; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; }
  .option:hover, .option:focus-visible { border-color: var(--accent); }
  small, label span { color: var(--fg-dim); }
  label { display: flex; flex-direction: column; gap: var(--sp-1); color: var(--fg); font-size: 0.85rem; }
  textarea { resize: vertical; padding: var(--sp-2); color: var(--fg); font: inherit; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; }
  textarea:focus { outline: none; border-color: var(--accent); }
  .actions { display: flex; justify-content: flex-end; }
  .cancel { padding: var(--sp-1) var(--sp-3); color: var(--fg); background: var(--bg); border: 1px solid var(--border); border-radius: 3px; cursor: pointer; }
  .error { color: var(--status-offline); font-size: 0.85rem; }
</style>
