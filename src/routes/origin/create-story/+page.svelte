<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { browser } from "$app/environment";
  import type { PageData, ActionData } from "./$types";
  import { createEditorStore } from "$lib/story-editor/editorStore";
  import { StoryCanvasController, type SelectionRect } from "$lib/story-editor/konvaEditor";
  import { loadImageFile } from "$lib/story-editor/imageLoader";
  import { DEFAULT_FONT_FAMILY, DEFAULT_TEXT_COLOR } from "$lib/story-editor/fonts";

  const FLOATING_TOOLBAR_HEIGHT = 44;
  const FLOATING_TOOLBAR_WIDTH = 96;
  const FLOATING_TOOLBAR_GAP = 8;

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

  // Serializable editor state (Phase 2) — the Konva stage below is only ever
  // a view synced from this store, never the other way round except on
  // gesture-end.
  const store = createEditorStore();
  // Local bindings so `$canUndo`/`$canRedo` auto-subscribe correctly —
  // `$store.canUndo` would instead (wrongly) look for a `canUndo` field on
  // the *EditorState* value that `$store` resolves to.
  const canUndo = store.canUndo;
  const canRedo = store.canRedo;

  let stageWrapperEl: HTMLDivElement;
  let canvasController: StoryCanvasController | null = null;

  let fileInputEl: HTMLInputElement;
  let pendingFileTarget: "base" | "photo-layer" | null = null;
  let fileError: string | null = null;

  // Bounding box of the current selection, in stage-local pixels — drives
  // the floating trash/duplicate toolbar's position (Phase 4). `null` when
  // nothing is selected.
  let selectionRect: SelectionRect | null = null;

  $: editorState = $store;
  $: hasBaseImage = editorState.baseImage !== null;
  $: floatingToolbarStyle = computeFloatingToolbarStyle(selectionRect);

  function computeFloatingToolbarStyle(rect: SelectionRect | null): string {
    if (!rect || !stageWrapperEl) return "display: none;";
    const stageWidth = stageWrapperEl.clientWidth;
    const stageHeight = stageWrapperEl.clientHeight;

    let left = rect.x + rect.width / 2 - FLOATING_TOOLBAR_WIDTH / 2;
    left = Math.max(4, Math.min(left, stageWidth - FLOATING_TOOLBAR_WIDTH - 4));

    // Prefer floating above the selection's bounding box; if that would go
    // off the top of the canvas (layer near the top edge), drop below it
    // instead so it's always visible.
    let top = rect.y - FLOATING_TOOLBAR_HEIGHT - FLOATING_TOOLBAR_GAP;
    if (top < 4) {
      top = rect.y + rect.height + FLOATING_TOOLBAR_GAP;
    }
    top = Math.min(top, stageHeight - FLOATING_TOOLBAR_HEIGHT - 4);

    return `left: ${left}px; top: ${top}px;`;
  }

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

    if (browser && hasSpheres && stageWrapperEl) {
      StoryCanvasController.create(stageWrapperEl, store, {
        onSelectionBoundsChange: (rect) => {
          selectionRect = rect;
        },
      }).then((controller) => {
        canvasController = controller;
      });
    }
  });

  onDestroy(() => {
    canvasController?.destroy();
    if (typeof document === "undefined") return;
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta && previousViewportContent !== null) {
      meta.setAttribute("content", previousViewportContent);
    }
    document.body.style.overflow = previousBodyOverflow;
  });

  function promptForBaseImage(): void {
    pendingFileTarget = "base";
    fileInputEl.click();
  }

  function promptForPhotoLayer(): void {
    pendingFileTarget = "photo-layer";
    fileInputEl.click();
  }

  async function handleFileChosen(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    const target = pendingFileTarget;
    pendingFileTarget = null;
    // Reset so choosing the same file again still fires a `change` event.
    input.value = "";
    if (!file || !target) return;

    try {
      const loaded = await loadImageFile(file);
      if (target === "base") {
        store.setBaseImage(loaded.url, loaded.width, loaded.height);
      } else {
        const stageSize = canvasController?.getStageSize() ?? { width: 320, height: 480 };
        const width = Math.min(loaded.width, stageSize.width * 0.7);
        const height = width * (loaded.height / loaded.width);
        store.addImageLayer(loaded.url, {
          x: (stageSize.width - width) / 2,
          y: (stageSize.height - height) / 2,
          width,
          height,
        });
      }
      fileError = null;
    } catch (err) {
      fileError = err instanceof Error ? err.message : "Could not load that image.";
    }
  }

  function addTextLayer(): void {
    const stageSize = canvasController?.getStageSize() ?? { width: 320, height: 480 };
    const width = Math.min(260, stageSize.width * 0.8);
    const id = store.addTextLayer({
      x: (stageSize.width - width) / 2,
      y: stageSize.height / 2 - 40,
      width,
      fontFamily: DEFAULT_FONT_FAMILY,
      color: DEFAULT_TEXT_COLOR,
    });
    // "Add text layer" immediately enters edit mode (Phase 3 requirement);
    // Phase 5 adds double-tap-to-re-enter for existing text layers.
    canvasController?.enterTextEditMode(id);
  }

  // The core "easily remove any layer" requirement — a floating trash icon
  // above the selected layer's bounding box (Phase 4).
  function deleteSelectedLayer(): void {
    const id = editorState.selectedLayerId;
    if (!id) return;
    store.deleteLayer(id);
  }

  function duplicateSelectedLayer(): void {
    const id = editorState.selectedLayerId;
    if (!id) return;
    store.duplicateLayer(id);
  }
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
      native scroll/zoom gestures.
    -->
    <div class="stage-wrapper" id="story-stage-wrapper" bind:this={stageWrapperEl}>
      {#if !hasBaseImage}
        <div class="pick-base-photo">
          <p>Pick a starting photo for your story.</p>
          <button type="button" class="primary-button" on:click={promptForBaseImage}>
            Choose photo
          </button>
        </div>
      {/if}

      {#if selectionRect && editorState.selectedLayerId}
        <div class="floating-toolbar" style={floatingToolbarStyle} role="toolbar">
          <button
            type="button"
            class="floating-button"
            aria-label="Duplicate layer"
            on:click={duplicateSelectedLayer}
          >
            ⧉
          </button>
          <button
            type="button"
            class="floating-button danger"
            aria-label="Delete layer"
            on:click={deleteSelectedLayer}
          >
            🗑
          </button>
        </div>
      {/if}
    </div>

    <input
      class="visually-hidden"
      type="file"
      accept="image/*"
      capture="environment"
      bind:this={fileInputEl}
      on:change={handleFileChosen}
    />

    {#if fileError}
      <p class="error" role="alert">{fileError}</p>
    {/if}

    <footer class="bottom-toolbar">
      <button
        type="button"
        class="toolbar-button"
        disabled={!hasBaseImage}
        on:click={promptForPhotoLayer}
      >
        Add photo layer
      </button>
      <button
        type="button"
        class="toolbar-button"
        disabled={!hasBaseImage}
        on:click={addTextLayer}
      >
        Add text layer
      </button>
      <button
        type="button"
        class="toolbar-button icon-button"
        disabled={!$canUndo}
        aria-label="Undo"
        on:click={() => store.undo()}
      >
        ↺
      </button>
      <button
        type="button"
        class="toolbar-button icon-button"
        disabled={!$canRedo}
        aria-label="Redo"
        on:click={() => store.redo()}
      >
        ↻
      </button>
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

  .floating-toolbar {
    position: absolute;
    display: flex;
    gap: 8px;
    z-index: 50;
    /* Pure DOM overlay — never touches Konva's own event system, so it
       can't accidentally trigger the stage's tap-to-deselect handler. */
  }

  .floating-button {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 2px solid white;
    background-color: rgba(20, 20, 24, 0.85);
    color: white;
    font-size: 1.1rem;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  }

  .floating-button.danger {
    background-color: rgba(200, 40, 40, 0.9);
  }

  .pick-base-photo {
    margin: auto;
    text-align: center;
    padding: 0 2rem;
  }

  .pick-base-photo p {
    opacity: 0.75;
    margin-bottom: 1rem;
  }

  .primary-button {
    background-color: lightblue;
    color: #1d3040;
    border: none;
    border-radius: 10px;
    padding: 0.6rem 1.4rem;
    font-weight: bold;
    font-size: 1rem;
  }

  .bottom-toolbar {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 0.75rem;
    flex: 0 0 auto;
    min-height: 3.5rem;
    padding: 0.75rem 1rem calc(0.75rem + env(safe-area-inset-bottom));
  }

  .toolbar-button {
    background-color: #1d3040;
    color: white;
    border: solid gray;
    border-radius: 10px;
    padding: 0.6rem 1rem;
    font-size: 0.9rem;
  }

  .toolbar-button:disabled {
    opacity: 0.4;
  }

  .icon-button {
    padding: 0.6rem 0.8rem;
    font-size: 1.1rem;
    line-height: 1;
  }

  .error {
    color: #ff6b6b;
    text-align: center;
    padding: 0 1rem 1rem;
  }
</style>
