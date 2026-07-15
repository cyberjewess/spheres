<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { browser } from "$app/environment";
  import { enhance, applyAction } from "$app/forms";
  import type { SubmitFunction } from "@sveltejs/kit";
  import type { PageData, ActionData } from "./$types";
  import { createEditorStore } from "$lib/story-editor/editorStore";
  import { StoryCanvasController, type SelectionRect } from "$lib/story-editor/konvaEditor";
  import { loadImageFile } from "$lib/story-editor/imageLoader";
  import { DEFAULT_FONT_FAMILY, DEFAULT_TEXT_COLOR, FONT_OPTIONS } from "$lib/story-editor/fonts";
  import type { Layer, TextLayer } from "$lib/story-editor/types";

  const MIN_FONT_SIZE = 8;
  const MAX_FONT_SIZE = 200;
  const FONT_SIZE_STEP = 4;

  const LONG_PRESS_MS = 350;
  const DRAG_CANCEL_THRESHOLD_PX = 10;

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
  // Konva's Stage constructor unconditionally does `container.innerHTML = '';`
  // (see node_modules/konva/lib/Stage.js `_buildDOM`) before inserting its own
  // `.konvajs-content` div — it wipes ANY existing children of whatever
  // element it's handed. `stage-wrapper` also hosts Svelte-rendered overlays
  // (the "choose photo" prompt, the floating trash/duplicate toolbar), so
  // Konva must never be given that element directly — it gets its own
  // dedicated, Svelte-untouched child element instead.
  let konvaContainerEl: HTMLDivElement;
  let canvasController: StoryCanvasController | null = null;
  // `StoryCanvasController.create` is async (awaits a dynamic `import("konva")`).
  // If the component unmounts before that resolves, `onDestroy`'s
  // `canvasController?.destroy()` no-ops on `null` and the controller that
  // finishes constructing afterward would never get destroyed, leaking its
  // ResizeObserver, touch listeners, and store subscription. This flag lets
  // the `.then()` callback below detect that case and destroy it immediately.
  let destroyed = false;

  let fileInputEl: HTMLInputElement;
  let pendingFileTarget: "base" | "photo-layer" | null = null;
  let fileError: string | null = null;

  // ---- export & submit (Phase 7) ------------------------------------------
  let caption = "";
  let isSubmitting = false;
  let submitError: string | null = null;
  let postFormEl: HTMLFormElement;
  let uploadedImageUrl = "";

  // Bounding box of the current selection, in stage-local pixels — drives
  // the floating trash/duplicate toolbar's position (Phase 4). `null` when
  // nothing is selected.
  let selectionRect: SelectionRect | null = null;

  // ---- layer list panel (Phase 6) -----------------------------------------
  let showLayerList = false;
  let layerListEl: HTMLDivElement;

  // Long-press + drag reorder state. A timer arms dragging after
  // LONG_PRESS_MS without significant movement, so an ordinary tap-to-select
  // or a list-scroll gesture isn't mistaken for a reorder drag.
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let pointerStart = { x: 0, y: 0 };
  let draggingLayerId: string | null = null;
  let dragOverIndex: number | null = null;
  let suppressNextRowClick = false;

  $: editorState = $store;
  $: hasBaseImage = editorState.baseImage !== null;
  $: floatingToolbarStyle = computeFloatingToolbarStyle(selectionRect);
  // Layer list is top-first (frontmost first) — the reverse of the store's
  // bottom-to-top array order.
  $: displayLayers = [...editorState.layers].reverse();
  // While a long-press-drag is in progress, reorder the *displayed* list
  // live for feedback, but don't touch the store until the drag ends — same
  // "commit on gesture-end, not every frame" rule as drag/transform/pinch on
  // the canvas itself.
  $: previewLayers = reorderPreview(displayLayers, draggingLayerId, dragOverIndex);
  // Only non-null when the current selection is a text layer — drives the
  // font/color/size panel (Phase 5). Kept as its own reactive value (rather
  // than narrowing `layer.type === "text"` inline in the template) so the
  // panel's markup can access TextLayer-only fields without re-deriving the
  // narrowing every time.
  $: selectedTextLayer = (() => {
    const layer = editorState.layers.find((l) => l.id === editorState.selectedLayerId);
    return layer && layer.type === "text" ? (layer as TextLayer) : null;
  })();

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

    if (browser && hasSpheres && konvaContainerEl) {
      StoryCanvasController.create(konvaContainerEl, store, {
        onSelectionBoundsChange: (rect) => {
          selectionRect = rect;
        },
      }).then((controller) => {
        if (destroyed) {
          // Component unmounted while Konva was still loading — destroy the
          // controller immediately instead of assigning it, so it doesn't
          // leak its ResizeObserver/touch listeners/store subscription.
          controller.destroy();
          return;
        }
        canvasController = controller;
      });
    }
  });

  onDestroy(() => {
    destroyed = true;
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

  // ---- text-layer style panel (Phase 5: font/color/size pickers) ----------
  // Uses `on:change`, not `on:input`, for the font/color controls — `input`
  // fires continuously while a native color picker is being dragged, and
  // committing every one of those to undo history would defeat the "commit
  // on gesture-end, not every frame" rule the rest of the editor follows.

  function handleFontChange(e: Event): void {
    if (!selectedTextLayer) return;
    const fontFamily = (e.currentTarget as HTMLSelectElement).value;
    store.updateLayer(selectedTextLayer.id, { fontFamily });
  }

  function handleColorChange(e: Event): void {
    if (!selectedTextLayer) return;
    const color = (e.currentTarget as HTMLInputElement).value;
    store.updateLayer(selectedTextLayer.id, { color });
  }

  function adjustFontSize(delta: number): void {
    if (!selectedTextLayer) return;
    const newSize = Math.max(
      MIN_FONT_SIZE,
      Math.min(MAX_FONT_SIZE, selectedTextLayer.fontSize + delta),
    );
    store.updateLayer(selectedTextLayer.id, { fontSize: newSize });
  }

  // ---- layer list: tap-to-select + long-press-drag-to-reorder (Phase 6) ---

  function layerLabel(layer: Layer): string {
    if (layer.type === "image") return "Photo layer";
    return layer.text.trim() || "Text layer";
  }

  function reorderPreview(
    list: Layer[],
    dragId: string | null,
    overIndex: number | null,
  ): Layer[] {
    if (!dragId || overIndex === null) return list;
    const fromIndex = list.findIndex((l) => l.id === dragId);
    if (fromIndex === -1 || fromIndex === overIndex) return list;
    const copy = [...list];
    const [moved] = copy.splice(fromIndex, 1);
    copy.splice(overIndex, 0, moved);
    return copy;
  }

  function handleRowClick(layerId: string): void {
    if (suppressNextRowClick) {
      suppressNextRowClick = false;
      return;
    }
    store.selectLayer(layerId);
  }

  function handleRowPointerDown(e: PointerEvent, layerId: string): void {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pointerStart = { x: e.clientX, y: e.clientY };
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      draggingLayerId = layerId;
      suppressNextRowClick = true;
      dragOverIndex = previewLayers.findIndex((l) => l.id === layerId);
    }, LONG_PRESS_MS);

    window.addEventListener("pointermove", handleWindowPointerMove, { passive: false });
    window.addEventListener("pointerup", handleWindowPointerUp, { once: true });
    window.addEventListener("pointercancel", handleWindowPointerUp, { once: true });
  }

  function handleWindowPointerMove(e: PointerEvent): void {
    if (draggingLayerId) {
      e.preventDefault();
      updateDragOverIndex(e.clientY);
      return;
    }
    // Not armed yet — a real long-press-drag hasn't started. If the pointer
    // has moved enough that this looks like a scroll/tap instead, cancel the
    // pending long-press so it doesn't fire mid-scroll.
    const dx = e.clientX - pointerStart.x;
    const dy = e.clientY - pointerStart.y;
    if (Math.hypot(dx, dy) > DRAG_CANCEL_THRESHOLD_PX && longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function updateDragOverIndex(clientY: number): void {
    if (!layerListEl) return;
    const rows = Array.from(layerListEl.querySelectorAll<HTMLElement>("[data-layer-row]"));
    let newIndex = rows.length - 1;
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        newIndex = i;
        break;
      }
    }
    dragOverIndex = newIndex;
  }

  function handleWindowPointerUp(): void {
    window.removeEventListener("pointermove", handleWindowPointerMove);
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    if (draggingLayerId && dragOverIndex !== null) {
      // previewLayers is displayed top-first; the store's `layers` array is
      // bottom-first, so the display index needs flipping before it's a
      // valid zIndex-style index for `reorderLayer`.
      const storeIndex = editorState.layers.length - 1 - dragOverIndex;
      store.reorderLayer(draggingLayerId, storeIndex);
    }
    draggingLayerId = null;
    dragOverIndex = null;
  }

  // ---- export & submit (Phase 7) ------------------------------------------
  //
  // Flow: flatten the stage to a JPEG blob (font-loaded check happens inside
  // `exportBlob` itself, right before drawing) -> upload it client-direct to
  // Vercel Blob via the storage adapter's token endpoint (/api/upload) ->
  // fill in the hidden form's imageUrl and submit it to the `createStoryPost`
  // action that's been ready since Phase 1.

  async function handlePost(): Promise<void> {
    if (!canvasController || isSubmitting) return;
    if (!hasBaseImage) {
      submitError = "Pick a starting photo first.";
      return;
    }
    if (!selectedSphereId) {
      submitError = "Choose a Sphere to post to.";
      return;
    }

    isSubmitting = true;
    submitError = null;

    try {
      const blob = await canvasController.exportBlob({
        pixelRatio: 2,
        mimeType: "image/jpeg",
        quality: 0.9,
      });

      // Client-direct upload — the browser streams straight to Vercel Blob;
      // our server never sees the image bytes, only the token
      // request/completion round trips via /api/upload (see that route and
      // the storage adapter in src/lib/server/storage/).
      const { upload } = await import("@vercel/blob/client");
      const pathname = `stories/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
      const result = await upload(pathname, blob, {
        access: "public",
        handleUploadUrl: "/api/upload",
        contentType: "image/jpeg",
      });

      uploadedImageUrl = result.url;
      await tick(); // let the hidden imageUrl input pick up the new value before submitting
      postFormEl.requestSubmit();
    } catch (err) {
      console.error("Story export/upload failed: " + err);
      submitError =
        err instanceof Error ? err.message : "Could not export or upload your story.";
      isSubmitting = false;
    }
  }

  const handlePostFormResult: SubmitFunction = () => {
    return async ({ result }) => {
      isSubmitting = false;
      await applyAction(result);
    };
  };
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
      <button
        type="button"
        class="layers-toggle"
        class:active={showLayerList}
        disabled={editorState.layers.length === 0}
        aria-pressed={showLayerList}
        on:click={() => (showLayerList = !showLayerList)}
      >
        Layers
      </button>
      <button
        type="button"
        class="post-button"
        disabled={!hasBaseImage || !selectedSphereId || isSubmitting}
        on:click={handlePost}
      >
        {isSubmitting ? "Posting…" : "Post"}
      </button>
    </header>

    <!--
      touch-action: none here so Konva's own touch handling (drag, and the
      hand-rolled two-finger pinch/twist added in Phase 4) isn't fought by
      native scroll/zoom gestures.
    -->
    <div class="stage-wrapper" id="story-stage-wrapper" bind:this={stageWrapperEl}>
      <!--
        Konva's Stage constructor wipes this element's children on mount
        (see the comment on `konvaContainerEl` above) — it must never hold
        anything Svelte itself renders, so it's a dedicated leaf element
        rather than `stage-wrapper` itself.
      -->
      <div class="konva-container" bind:this={konvaContainerEl}></div>

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

    {#if selectedTextLayer}
      <div class="text-style-panel">
        <label class="style-field">
          <span class="visually-hidden">Font</span>
          <select value={selectedTextLayer.fontFamily} on:change={handleFontChange}>
            {#each FONT_OPTIONS as font}
              <option value={font.family} style="font-family: '{font.family}', sans-serif">
                {font.label}
              </option>
            {/each}
          </select>
        </label>

        <div class="style-field size-field">
          <button
            type="button"
            class="size-button"
            aria-label="Decrease font size"
            on:click={() => adjustFontSize(-FONT_SIZE_STEP)}
          >
            −
          </button>
          <span class="size-value">{selectedTextLayer.fontSize}</span>
          <button
            type="button"
            class="size-button"
            aria-label="Increase font size"
            on:click={() => adjustFontSize(FONT_SIZE_STEP)}
          >
            +
          </button>
        </div>

        <label class="style-field color-field">
          <span class="visually-hidden">Text color</span>
          <input type="color" value={selectedTextLayer.color} on:change={handleColorChange} />
        </label>
      </div>
    {/if}

    {#if showLayerList}
      <div class="layer-list-panel" bind:this={layerListEl}>
        {#if previewLayers.length === 0}
          <p class="layer-list-empty">No layers yet.</p>
        {/if}
        {#each previewLayers as layer (layer.id)}
          <div
            class="layer-row"
            class:selected={editorState.selectedLayerId === layer.id}
            class:dragging={draggingLayerId === layer.id}
            data-layer-row
            role="button"
            tabindex="0"
            on:click={() => handleRowClick(layer.id)}
            on:keydown={(e) => e.key === "Enter" && handleRowClick(layer.id)}
            on:pointerdown={(e) => handleRowPointerDown(e, layer.id)}
          >
            <span class="layer-thumb">
              {#if layer.type === "image"}
                <img src={layer.src} alt="" />
              {:else}
                <span class="layer-thumb-text" style="color: {layer.color}">Aa</span>
              {/if}
            </span>
            <span class="layer-label">{layerLabel(layer)}</span>
            <span class="layer-grip" aria-hidden="true">⠿</span>
          </div>
        {/each}
      </div>
    {/if}

    {#if hasBaseImage}
      <div class="caption-row">
        <input
          type="text"
          class="caption-input"
          placeholder="Add a caption (optional)"
          maxlength="120"
          bind:value={caption}
        />
      </div>
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

    {#if submitError}
      <p class="error" role="alert">{submitError}</p>
    {/if}

    <!--
      Hidden form for the actual submit — kept separate from the visible
      "Post" button because posting needs an async pre-step (export +
      client-direct upload) to finish and fill in imageUrl before this can
      be submitted. `handlePost` calls `requestSubmit()` once that's done.
    -->
    <form
      method="POST"
      action="?/createStoryPost"
      bind:this={postFormEl}
      use:enhance={handlePostFormResult}
      class="visually-hidden"
    >
      <input type="hidden" name="sphere" value={selectedSphereId ?? ""} />
      <input type="hidden" name="title" value={caption} />
      <input type="hidden" name="imageUrl" bind:value={uploadedImageUrl} />
    </form>
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
    flex-wrap: wrap;
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

  .layers-toggle {
    background-color: #1d3040;
    color: white;
    border: solid gray;
    border-radius: 8px;
    padding: 0.4rem 0.7rem;
    font-size: 0.85rem;
  }

  .layers-toggle.active {
    background-color: lightblue;
    color: #1d3040;
    font-weight: bold;
  }

  .layers-toggle:disabled {
    opacity: 0.4;
  }

  .post-button {
    background-color: lightblue;
    color: #1d3040;
    border: none;
    border-radius: 8px;
    padding: 0.45rem 1rem;
    font-weight: bold;
    font-size: 0.9rem;
  }

  .post-button:disabled {
    opacity: 0.4;
  }

  .caption-row {
    flex: 0 0 auto;
    padding: 0.3rem 1rem;
  }

  .caption-input {
    width: 100%;
    box-sizing: border-box;
    background-color: rgba(255, 255, 255, 0.08);
    color: white;
    border: solid gray;
    border-radius: 10px;
    padding: 0.5rem 0.75rem;
    font-size: 0.95rem;
  }

  .caption-input::placeholder {
    color: rgba(255, 255, 255, 0.5);
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

  .konva-container {
    position: absolute;
    inset: 0;
    z-index: 0;
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
    /* Explicit stacking context, z-index above .konva-container (0) — CSS
       paints *any* positioned element above non-positioned in-flow siblings
       regardless of DOM order, so without this the (empty, but still
       painted) Konva canvas would visually cover this prompt. */
    position: relative;
    z-index: 1;
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

  .text-style-panel {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.6rem;
    flex: 0 0 auto;
    padding: 0.5rem 1rem;
    flex-wrap: wrap;
  }

  .style-field select {
    background-color: #1d3040;
    color: white;
    border: solid gray;
    border-radius: 8px;
    padding: 0.4rem 0.5rem;
    max-width: 9.5rem;
  }

  .size-field {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background-color: #1d3040;
    border: solid gray;
    border-radius: 8px;
    padding: 0.2rem 0.5rem;
  }

  .size-button {
    background: none;
    border: none;
    color: white;
    font-size: 1.1rem;
    width: 1.6rem;
    height: 1.6rem;
    line-height: 1;
  }

  .size-value {
    min-width: 2.2rem;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  .color-field input[type="color"] {
    width: 2.2rem;
    height: 2.2rem;
    padding: 0;
    border: solid gray;
    border-radius: 8px;
    background: none;
  }

  .layer-list-panel {
    flex: 0 0 auto;
    max-height: 35dvh;
    overflow-y: auto;
    padding: 0.5rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    background-color: rgba(255, 255, 255, 0.04);
    /* Long-press-drag needs vertical pointer moves to reach us before the
       browser starts a native scroll; a plain tap/scroll still works
       because the long-press timer (350ms) filters those out. */
    touch-action: pan-y;
  }

  .layer-list-empty {
    text-align: center;
    opacity: 0.6;
    padding: 0.5rem 0;
  }

  .layer-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.4rem 0.6rem;
    border: solid gray;
    border-radius: 8px;
    background-color: #16232e;
    user-select: none;
    touch-action: none;
  }

  .layer-row.selected {
    border-color: lightblue;
    background-color: #1d3040;
  }

  .layer-row.dragging {
    opacity: 0.6;
    border-color: lightblue;
  }

  .layer-thumb {
    width: 36px;
    height: 36px;
    border-radius: 6px;
    overflow: hidden;
    background-color: #0b0b0d;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
  }

  .layer-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .layer-thumb-text {
    font-weight: bold;
    font-size: 0.9rem;
  }

  .layer-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.9rem;
  }

  .layer-grip {
    opacity: 0.5;
    font-size: 1.1rem;
    padding: 0 0.2rem;
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
