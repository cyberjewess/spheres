/**
 * Imperative Konva scene controller for the Story Editor.
 *
 * Deliberately NOT using the `svelte-konva` wrapper (see docs/Story Editor.md,
 * Phase 2 deviation note) — Konva nodes here are the *view*, driven straight
 * from `EditorStore`'s snapshots in `onMount`/`onDestroy`. The store is only
 * ever written back to on a committed gesture (drag-end, transform-end,
 * text-edit-commit) — never on every animation frame — so a store update
 * safely re-applies to the live nodes without fighting an in-progress
 * gesture (by the time the store changes, the gesture that caused it has
 * already ended).
 *
 * Konva itself is dynamically imported inside `create()`, which is only ever
 * called from the editor route's `onMount` (client-only) — this keeps Konva
 * out of the SSR bundle and out of any shared/main bundle chunk.
 */
import type KonvaNamespace from "konva";
import type { EditorState, Layer, TextLayer } from "./types";
import type { EditorStore } from "./editorStore";

type Konva = typeof KonvaNamespace;
// Konva's own types don't export a single "any node" alias that's convenient
// to store in a heterogeneous map, so we deal in `KonvaNamespace.Node` and
// narrow with `instanceof` where it matters (image vs. text specifics).
type AnyNode = KonvaNamespace.Node;

export interface StageSize {
  width: number;
  height: number;
}

const BASE_IMAGE_NAME = "story-editor-base-image";

export class StoryCanvasController {
  private readonly Konva: Konva;
  private readonly container: HTMLDivElement;
  private readonly store: EditorStore;

  private stage!: KonvaNamespace.Stage;
  private mainLayer!: KonvaNamespace.Layer;
  private baseImageNode: KonvaNamespace.Image | null = null;
  private readonly nodesById = new Map<string, AnyNode>();

  private resizeObserver: ResizeObserver | null = null;
  private unsubscribe: () => void = () => {};
  private destroyed = false;

  /** Active textarea-overlay edit session, if any (Phase 5 double-tap reuses this). */
  private activeTextEdit: { layerId: string; textarea: HTMLTextAreaElement } | null = null;

  private constructor(container: HTMLDivElement, store: EditorStore, Konva: Konva) {
    this.container = container;
    this.store = store;
    this.Konva = Konva;
  }

  static async create(
    container: HTMLDivElement,
    store: EditorStore,
  ): Promise<StoryCanvasController> {
    const mod = await import("konva");
    const Konva = mod.default;
    const controller = new StoryCanvasController(container, store, Konva);
    controller.init();
    return controller;
  }

  private init(): void {
    const rect = this.container.getBoundingClientRect();
    this.stage = new this.Konva.Stage({
      container: this.container,
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    });
    this.mainLayer = new this.Konva.Layer();
    this.stage.add(this.mainLayer);

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(this.container);
    }

    this.unsubscribe = this.store.subscribe((state) => this.syncFromStore(state));
  }

  getStageSize(): StageSize {
    return { width: this.stage.width(), height: this.stage.height() };
  }

  private handleResize(): void {
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (width === this.stage.width() && height === this.stage.height()) return;
    this.stage.width(width);
    this.stage.height(height);
    // Note: existing layer x/y are stage-pixel coordinates fixed at the size
    // the stage had when they were placed; we deliberately don't attempt to
    // proportionally re-flow every layer on resize (e.g. an orientation
    // change mid-edit) — a real reflow needs a "design size" vs "stage size"
    // distinction that's out of scope for this phase. Re-fitting the base
    // image is enough to keep the background sane.
    this.fitBaseImage();
    this.mainLayer.batchDraw();
  }

  // ---- store -> Konva sync -------------------------------------------------

  private syncFromStore(state: EditorState): void {
    this.syncBaseImage(state);
    this.syncLayers(state);
    this.mainLayer.batchDraw();
  }

  private lastBaseImageSrc: string | null = null;

  private syncBaseImage(state: EditorState): void {
    if (!state.baseImage) {
      if (this.baseImageNode) {
        this.baseImageNode.destroy();
        this.baseImageNode = null;
        this.lastBaseImageSrc = null;
      }
      return;
    }

    if (this.lastBaseImageSrc === state.baseImage && this.baseImageNode) {
      return;
    }
    this.lastBaseImageSrc = state.baseImage;

    const imageEl = new window.Image();
    imageEl.src = state.baseImage;
    const applyImage = () => {
      if (this.destroyed) return;
      if (!this.baseImageNode) {
        this.baseImageNode = new this.Konva.Image({
          image: imageEl,
          name: BASE_IMAGE_NAME,
          listening: false, // background — not selectable/draggable
        });
        this.mainLayer.add(this.baseImageNode);
      } else {
        this.baseImageNode.image(imageEl);
      }
      this.baseImageNode.moveToBottom();
      this.fitBaseImage(state);
      this.mainLayer.batchDraw();
    };
    if (imageEl.complete && imageEl.naturalWidth > 0) {
      applyImage();
    } else {
      imageEl.onload = applyImage;
    }
  }

  /** Contain-fit (letterbox) the base photo within the current stage size, centered. */
  private fitBaseImage(state?: EditorState): void {
    if (!this.baseImageNode) return;
    const width = state?.baseImageWidth ?? 0;
    const height = state?.baseImageHeight ?? 0;
    if (!width || !height) return;
    const stageWidth = this.stage.width();
    const stageHeight = this.stage.height();
    const scale = Math.min(stageWidth / width, stageHeight / height);
    const fittedWidth = width * scale;
    const fittedHeight = height * scale;
    this.baseImageNode.setAttrs({
      width: fittedWidth,
      height: fittedHeight,
      x: (stageWidth - fittedWidth) / 2,
      y: (stageHeight - fittedHeight) / 2,
    });
  }

  private syncLayers(state: EditorState): void {
    const seenIds = new Set<string>();

    state.layers.forEach((layer, index) => {
      seenIds.add(layer.id);
      let node = this.nodesById.get(layer.id);
      if (!node) {
        node = this.createNodeForLayer(layer);
        this.nodesById.set(layer.id, node);
        this.mainLayer.add(node as never);
      } else if (!this.isBeingEdited(layer.id)) {
        // Don't stomp on a node whose textarea overlay is currently live —
        // its Konva node is intentionally hidden/stale until edit commits.
        this.updateNodeFromLayer(node, layer);
      }
      // +1 keeps index 0 reserved for the base image at the very bottom.
      node.zIndex(index + 1);
    });

    for (const [id, node] of this.nodesById) {
      if (!seenIds.has(id)) {
        node.destroy();
        this.nodesById.delete(id);
      }
    }
  }

  private isBeingEdited(layerId: string): boolean {
    return this.activeTextEdit?.layerId === layerId;
  }

  private createNodeForLayer(layer: Layer): AnyNode {
    if (layer.type === "image") {
      const imageEl = new window.Image();
      imageEl.src = layer.src;
      const node = new this.Konva.Image({
        image: imageEl,
        x: layer.x,
        y: layer.y,
        width: layer.width,
        height: layer.height,
        rotation: layer.rotation,
        draggable: false, // enabled in Phase 4 alongside selection/Transformer
      });
      if (!(imageEl.complete && imageEl.naturalWidth > 0)) {
        imageEl.onload = () => {
          if (!this.destroyed) this.mainLayer.batchDraw();
        };
      }
      return node;
    }

    return this.createTextNode(layer);
  }

  private createTextNode(layer: TextLayer): KonvaNamespace.Text {
    return new this.Konva.Text({
      x: layer.x,
      y: layer.y,
      width: layer.width,
      rotation: layer.rotation,
      text: layer.text,
      fontFamily: layer.fontFamily,
      fontSize: layer.fontSize,
      fill: layer.color,
      align: layer.align,
      draggable: false, // enabled in Phase 4
      padding: 4,
      wrap: "word",
    });
  }

  private updateNodeFromLayer(node: AnyNode, layer: Layer): void {
    if (layer.type === "image") {
      const imageNode = node as KonvaNamespace.Image;
      imageNode.setAttrs({
        x: layer.x,
        y: layer.y,
        width: layer.width,
        height: layer.height,
        rotation: layer.rotation,
      });
      const currentImage = imageNode.image() as HTMLImageElement | undefined;
      if (!currentImage || currentImage.src !== layer.src) {
        const imageEl = new window.Image();
        imageEl.src = layer.src;
        imageEl.onload = () => {
          imageNode.image(imageEl);
          if (!this.destroyed) this.mainLayer.batchDraw();
        };
      }
    } else {
      const textNode = node as KonvaNamespace.Text;
      textNode.setAttrs({
        x: layer.x,
        y: layer.y,
        width: layer.width,
        rotation: layer.rotation,
        text: layer.text,
        fontFamily: layer.fontFamily,
        fontSize: layer.fontSize,
        fill: layer.color,
        align: layer.align,
      });
    }
  }

  // ---- adding layers (Phase 3) --------------------------------------------

  /**
   * Enters text-edit mode for a given layer: hides the Konva.Text node and
   * overlays an absolutely-positioned HTML `<textarea>` matching its
   * position/size/rotation/font — Konva's own documented pattern for
   * editable canvas text (see Konva's "Editable text" recipe). Swaps back
   * to the Konva.Text node on blur, committing the final text to the store.
   *
   * Used both for "immediately edit a freshly-added text layer" (Phase 3)
   * and double-tap-to-edit an existing one (Phase 5).
   */
  enterTextEditMode(layerId: string): void {
    const node = this.nodesById.get(layerId);
    if (!node || !(node instanceof this.Konva.Text)) return;
    if (this.activeTextEdit) this.commitActiveTextEdit();
    this.startTextEditing(node, layerId);
  }

  private startTextEditing(textNode: KonvaNamespace.Text, layerId: string): void {
    textNode.hide();
    this.mainLayer.batchDraw();

    const containerRect = this.container.getBoundingClientRect();
    const padding = textNode.padding();

    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.value = textNode.text();

    const rotation = textNode.rotation();
    Object.assign(textarea.style, {
      position: "fixed",
      top: `${containerRect.top + textNode.y()}px`,
      left: `${containerRect.left + textNode.x()}px`,
      width: `${Math.max(20, textNode.width() - padding * 2)}px`,
      height: `${Math.max(20, textNode.height() - padding * 2 + 6)}px`,
      fontSize: `${textNode.fontSize()}px`,
      fontFamily: textNode.fontFamily(),
      color: String(textNode.fill()),
      textAlign: textNode.align(),
      border: "none",
      padding: "0px",
      margin: "0px",
      overflow: "hidden",
      background: "transparent",
      outline: "2px dashed rgba(255, 255, 255, 0.75)",
      outlineOffset: "4px",
      resize: "none",
      lineHeight: "1.15",
      transformOrigin: "left top",
      transform: rotation ? `rotate(${rotation}deg)` : "",
      zIndex: "1000",
      caretColor: String(textNode.fill()),
    } satisfies Partial<CSSStyleDeclaration>);

    textarea.focus();
    textarea.select();

    this.activeTextEdit = { layerId, textarea };

    const handleBlur = () => this.commitActiveTextEdit();
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        textarea.blur();
      }
    };
    textarea.addEventListener("blur", handleBlur);
    textarea.addEventListener("keydown", handleKeydown);
  }

  private commitActiveTextEdit(): void {
    const active = this.activeTextEdit;
    if (!active) return;
    this.activeTextEdit = null;

    const { layerId, textarea } = active;
    const value = textarea.value;
    textarea.remove();

    const node = this.nodesById.get(layerId);
    if (node instanceof this.Konva.Text) {
      node.show();
      this.mainLayer.batchDraw();
    }

    this.store.updateLayer(layerId, { text: value } as Partial<Layer>);
  }

  // ---- export (Phase 7 wires this up further) ------------------------------

  toDataURL(options: Parameters<KonvaNamespace.Stage["toDataURL"]>[0] = {}): string {
    return this.stage.toDataURL(options);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.activeTextEdit) {
      this.activeTextEdit.textarea.remove();
      this.activeTextEdit = null;
    }
    this.resizeObserver?.disconnect();
    this.unsubscribe();
    this.stage.destroy();
  }
}
