<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { PageData, ActionData } from "./$types";

  export let data: PageData;
  export let form: ActionData;

  let userSpheres = data.userSpheres ?? [];
  let hasSpheres = userSpheres.length > 0;
  let selectedSphereId: number | null = userSpheres[0]?.id ?? null;

  // Scoped mobile-viewport tweak: lock pinch-zoom so it doesn't fight the
  // canvas's own pinch/rotate gesture. Only touches this route's document
  // state — restored on destroy, the root <meta viewport> tag itself
  // (src/app.html) is never edited.
  let previousViewportContent: string | null = null;
  let previousBodyOverflow = "";

  onMount(() => {
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta) {
      previousViewportContent = meta.getAttribute("content");
      meta.setAttribute(
        "content",
        "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no",
      );
    }
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  });

  onDestroy(() => {
    if (typeof document === "undefined") return;
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta && previousViewportContent !== null) {
      meta.setAttribute("content", previousViewportContent);
    }
    document.body.style.overflow = previousBodyOverflow;
  });
</script>

<svelte:head>
  <title>New Story - Spheres</title>
</svelte:head>

<div class="editor-viewport">
  {#if !hasSpheres}
    <div class="empty-state">
      <h2>Make a Sphere first</h2>
      <p>You'll need a Sphere of your own to post a story to.</p>
      <a href="/origin" role="button">Back to Origin</a>
    </div>
  {:else}
    <header class="top-bar">
      <a class="close-button" href="/origin" aria-label="Cancel and go back to Origin">
        &times;
      </a>
      <label class="sphere-picker">
        <span class="visually-hidden">Sphere to post to</span>
        <select bind:value={selectedSphereId} name="sphere">
          {#each userSpheres as sphere}
            <option value={sphere.id}>{sphere.name}</option>
          {/each}
        </select>
      </label>
    </header>

    <!--
      touch-action: none here so Konva's own touch handling (drag, and the
      hand-rolled two-finger pinch/twist added in Phase 4) isn't fought by
      native scroll/zoom gestures. The Konva stage mounts into this element
      starting in Phase 3.
    -->
    <div class="stage-wrapper" id="story-stage-wrapper">
      <p class="placeholder-hint">Canvas editor lands in the next phase.</p>
    </div>

    <footer class="bottom-toolbar">
      <!-- Add-photo / add-text buttons land here in Phase 3. -->
    </footer>

    {#if form?.message}
      <p class="error" role="alert">{form.message}</p>
    {/if}
  {/if}
</div>

<style>
  /*
   * position: fixed + inset: 0 deliberately breaks this route's editor out
   * of the root layout's centered, 90%-width body (src/routes/+layout.svelte)
   * without touching that global stylesheet — this route wants a true
   * full-bleed mobile viewport, every other route keeps the centered look.
   */
  .editor-viewport {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    height: 100dvh;
    width: 100%;
    background-color: #0b0b0d;
    color: white;
    z-index: 100;
  }

  .empty-state {
    margin: auto;
    text-align: center;
    padding: 2rem;
  }

  .top-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    gap: 0.5rem;
    flex: 0 0 auto;
  }

  .close-button {
    font-size: 1.75rem;
    line-height: 1;
    color: white;
    padding: 0.25rem 0.6rem;
  }

  .sphere-picker select {
    background-color: #1d3040;
    color: white;
    border: solid gray;
    border-radius: 8px;
    padding: 0.35rem 0.5rem;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .stage-wrapper {
    flex: 1;
    position: relative;
    touch-action: none;
    overflow: hidden;
    display: flex;
  }

  .placeholder-hint {
    margin: auto;
    text-align: center;
    opacity: 0.6;
    padding: 0 2rem;
  }

  .bottom-toolbar {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 1rem;
    flex: 0 0 auto;
    min-height: 3.5rem;
    padding: 0.75rem 1rem calc(0.75rem + env(safe-area-inset-bottom));
  }

  .error {
    color: #ff6b6b;
    text-align: center;
    padding: 0 1rem 1rem;
  }
</style>
