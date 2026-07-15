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
import type { EditorState, ImageLayer, Layer, TextLayer } from "./types";
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

/** Axis-aligned bounding box of the current selection, in stage-local pixels. */
export interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StoryCanvasOptions {
  /** Fired whenever the selected layer's on-screen bounding box changes (select/drag/transform/pinch), or with `null` when nothing is selected. Drives the floating trash/duplicate toolbar position. */
  onSelectionBoundsChange?: (rect: SelectionRect | null) => void;
}

const BASE_IMAGE_NAME = "story-editor-base-image";
const MIN_NODE_SIZE = 10;
const MIN_FONT_SIZE = 6;

function touchDistance(a: Touch, b: Touch): number {
  return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
}

function touchAngleDeg(a: Touch, b: Touch): number {
  return (Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX) * 180) / Math.PI;
}

export class StoryCanvasController {
  private readonly Konva: Konva;
  private readonly container: HTMLDivElement;
  private readonly store: EditorStore;
  private readonly options: StoryCanvasOptions;

  private stage!: KonvaNamespace.Stage;
  private mainLayer!: KonvaNamespace.Layer;
  private transformer!: KonvaNamespace.Transformer;
  private baseImageNode: KonvaNamespace.Image | null = null;
  private readonly nodesById = new Map<string, AnyNode>();

  private resizeObserver: ResizeObserver | null = null;
  private unsubscribe: () => void = () => {};
  private destroyed = false;
  private selectedLayerId: string | null = null;

  /** Active textarea-overlay edit session, if any (Phase 5 double-tap reuses this). */
  private activeTextEdit: { layerId: string; textarea: HTMLTextAreaElement } | null = null;

  /** Hand-rolled two-finger pinch (scale) + twist (rotate) gesture state, Phase 4. */
  private pinchState: {
    layerId: string;
    node: AnyNode;
    lastDist: number;
    lastAngle: number;
    wasDraggable: boolean;
  } | null = null;

  private constructor(
    container: HTMLDivElement,
    store: EditorStore,
    Konva: Konva,
    options: StoryCanvasOptions,
  ) {
    this.container = container;
    this.store = store;
    this.Konva = Konva;
    this.options = options;
  }

  static async create(
    container: HTMLDivElement,
    store: EditorStore,
    options: StoryCanvasOptions = {},
  ): Promise<StoryCanvasController> {
    const mod = await import("konva");
    const Konva = mod.default;
    const controller = new StoryCanvasController(container, store, Konva, options);
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

    this.transformer = new this.Konva.Transformer({
      rotateEnabled: true,
      flipEnabled: false,
      boundBoxFunc: (oldBox, newBox) => {
        if (Math.abs(newBox.width) < MIN_NODE_SIZE || Math.abs(newBox.height) < MIN_NODE_SIZE) {
          return oldBox;
        }
        return newBox;
      },
    });
    this.mainLayer.add(this.transformer);
    this.transformer.on("transform", () => this.emitSelectionBounds());
    this.transformer.on("transformend", () => {
      const node = this.transformer.nodes()[0] as AnyNode | undefined;
      if (!node) return;
      const layerId = this.findLayerIdForNode(node);
      if (layerId) this.bakeAndCommitTransform(layerId, node);
    });

    // Tap/click on empty stage area (or the non-listening base image, whose
    // events pass through to the stage) deselects — standard Konva pattern.
    this.stage.on("click tap", (e) => {
      if (e.target === this.stage) {
        this.store.selectLayer(null);
      }
    });

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(this.container);
    }

    this.attachPinchGestures();

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
    this.emitSelectionBounds();
  }

  // ---- store -> Konva sync -------------------------------------------------

  private syncFromStore(state: EditorState): void {
    this.syncBaseImage(state);
    this.syncLayers(state);
    this.syncSelection(state);
    this.transformer.moveToTop();
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
      } else if (!this.isBeingEdited(layer.id) && !this.isBeingTransformed(layer.id)) {
        // Don't stomp on a node whose textarea overlay or pinch gesture is
        // currently live — its authoritative state is the live Konva node,
        // not the (stale, pre-commit) store snapshot.
        this.updateNodeFromLayer(node, layer);
      }
      // +1 keeps index 0 reserved for the base image at the very bottom.
      node.zIndex(index + 1);
    });

    for (const [id, node] of this.nodesById) {
      if (!seenIds.has(id)) {
        if (this.selectedLayerId === id) {
          this.transformer.nodes([]);
        }
        node.destroy();
        this.nodesById.delete(id);
      }
    }
  }

  private syncSelection(state: EditorState): void {
    this.selectedLayerId = state.selectedLayerId;
    const node = state.selectedLayerId ? this.nodesById.get(state.selectedLayerId) : undefined;
    if (!node) {
      this.transformer.nodes([]);
      this.emitSelectionBounds();
      return;
    }
    this.transformer.nodes([node]);
    this.emitSelectionBounds();
  }

  private isBeingEdited(layerId: string): boolean {
    return this.activeTextEdit?.layerId === layerId;
  }

  private isBeingTransformed(layerId: string): boolean {
    return this.pinchState?.layerId === layerId;
  }

  private createNodeForLayer(layer: Layer): AnyNode {
    const node: AnyNode =
      layer.type === "image" ? this.createImageNode(layer) : this.createTextNode(layer);
    this.attachInteractions(node, layer.id);
    return node;
  }

  private createImageNode(layer: ImageLayer): KonvaNamespace.Image {
    const imageEl = new window.Image();
    imageEl.src = layer.src;
    const node = new this.Konva.Image({
      image: imageEl,
      x: layer.x,
      y: layer.y,
      width: layer.width,
      height: layer.height,
      rotation: layer.rotation,
      draggable: true,
    });
    if (!(imageEl.complete && imageEl.naturalWidth > 0)) {
      imageEl.onload = () => {
        if (!this.destroyed) this.mainLayer.batchDraw();
      };
    }
    return node;
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
      draggable: true,
      padding: 4,
      wrap: "word",
    });
  }

  /** Tap-to-select, drag-to-move — wired once per node at creation time (Phase 4). */
  private attachInteractions(node: AnyNode, layerId: string): void {
    node.on("click tap", (evt) => {
      // Stop this from bubbling to the stage's own "click tap" handler,
      // which would otherwise immediately deselect again.
      evt.cancelBubble = true;
      this.store.selectLayer(layerId);
    });
    node.on("dragstart", () => {
      this.store.selectLayer(layerId);
    });
    node.on("dragmove", () => {
      this.emitSelectionBounds();
    });
    node.on("dragend", () => {
      this.store.updateLayer(layerId, { x: node.x(), y: node.y() } as Partial<Layer>);
      this.emitSelectionBounds();
    });

    // Double-tap/double-click a text layer to re-enter edit mode (Phase 5) —
    // reuses the same textarea-overlay swap "Add text layer" (Phase 3)
    // already enters immediately after creation.
    if (node instanceof this.Konva.Text) {
      node.on("dblclick dbltap", (evt) => {
        evt.cancelBubble = true;
        this.enterTextEditMode(layerId);
      });
    }
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

  // ---- transform-end bake (Transformer handles + pinch gesture) -----------

  private findLayerIdForNode(node: AnyNode): string | null {
    for (const [id, n] of this.nodesById) {
      if (n === node) return id;
    }
    return null;
  }

  /**
   * Bakes a Konva node's accumulated `scaleX`/`scaleY` back into real
   * width/height (images) or `fontSize`/width (text — resizing text by
   * leaving it as a bitmap scale would go blurry/pixelated), resets scale to
   * 1, and commits the result to the store. Shared by Transformer
   * handle-drags and the hand-rolled pinch gesture below.
   */
  private bakeAndCommitTransform(layerId: string, node: AnyNode): void {
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    const rotation = node.rotation();
    const x = node.x();
    const y = node.y();

    if (node instanceof this.Konva.Text) {
      const averageScale = (scaleX + scaleY) / 2;
      const newFontSize = Math.max(MIN_FONT_SIZE, Math.round(node.fontSize() * averageScale));
      const newWidth = Math.max(20, node.width() * scaleX);
      node.setAttrs({ fontSize: newFontSize, width: newWidth, scaleX: 1, scaleY: 1 });
      this.store.updateLayer(layerId, {
        x,
        y,
        rotation,
        width: newWidth,
        fontSize: newFontSize,
      } as Partial<Layer>);
    } else if (node instanceof this.Konva.Image) {
      const newWidth = Math.max(MIN_NODE_SIZE, node.width() * scaleX);
      const newHeight = Math.max(MIN_NODE_SIZE, node.height() * scaleY);
      node.setAttrs({ width: newWidth, height: newHeight, scaleX: 1, scaleY: 1 });
      this.store.updateLayer(layerId, {
        x,
        y,
        rotation,
        width: newWidth,
        height: newHeight,
      } as Partial<Layer>);
    }
    this.emitSelectionBounds();
  }

  // ---- hand-rolled two-finger pinch (scale) + twist (rotate) --------------
  //
  // Konva's Transformer only handles single-pointer handle-drag resize/
  // rotate; simultaneous two-finger pinch+twist (the core IG-story gesture)
  // isn't built in, so this follows Konva's documented multi-touch recipe:
  // two-touch distance -> scale, two-touch angle -> rotation. Registered
  // with { passive: false } so preventDefault() actually stops the page
  // from scrolling/zooming during the gesture (touch-action: none on the
  // stage wrapper, set in Phase 1, is the other half of that).

  private attachPinchGestures(): void {
    this.container.addEventListener("touchstart", this.handleTouchStart, { passive: false });
    this.container.addEventListener("touchmove", this.handleTouchMove, { passive: false });
    this.container.addEventListener("touchend", this.handleTouchEnd, { passive: false });
    this.container.addEventListener("touchcancel", this.handleTouchEnd, { passive: false });
  }

  private detachPinchGestures(): void {
    this.container.removeEventListener("touchstart", this.handleTouchStart);
    this.container.removeEventListener("touchmove", this.handleTouchMove);
    this.container.removeEventListener("touchend", this.handleTouchEnd);
    this.container.removeEventListener("touchcancel", this.handleTouchEnd);
  }

  private handleTouchStart = (e: TouchEvent): void => {
    if (e.touches.length !== 2 || !this.selectedLayerId) return;
    const node = this.nodesById.get(this.selectedLayerId);
    if (!node) return;
    e.preventDefault();

    // Hand off from Konva's own single-pointer drag to our manual transform
    // for the duration of the gesture, so the two systems don't fight.
    const wasDraggable = node.draggable();
    if (typeof (node as unknown as { isDragging?: () => boolean }).isDragging === "function") {
      const draggableNode = node as unknown as { isDragging: () => boolean; stopDrag: () => void };
      if (draggableNode.isDragging()) draggableNode.stopDrag();
    }
    node.draggable(false);

    const [t1, t2] = [e.touches[0], e.touches[1]];
    this.pinchState = {
      layerId: this.selectedLayerId,
      node,
      lastDist: touchDistance(t1, t2),
      lastAngle: touchAngleDeg(t1, t2),
      wasDraggable,
    };
  };

  private handleTouchMove = (e: TouchEvent): void => {
    if (!this.pinchState || e.touches.length !== 2) return;
    e.preventDefault();

    const [t1, t2] = [e.touches[0], e.touches[1]];
    const dist = touchDistance(t1, t2);
    const angle = touchAngleDeg(t1, t2);
    const { node, lastDist, lastAngle } = this.pinchState;

    if (lastDist > 0) {
      const scaleBy = dist / lastDist;
      node.scaleX(node.scaleX() * scaleBy);
      node.scaleY(node.scaleY() * scaleBy);
    }
    node.rotation(node.rotation() + (angle - lastAngle));

    this.pinchState.lastDist = dist;
    this.pinchState.lastAngle = angle;

    this.transformer.forceUpdate();
    this.mainLayer.batchDraw();
    this.emitSelectionBounds();
  };

  private handleTouchEnd = (e: TouchEvent): void => {
    if (!this.pinchState) return;
    if (e.touches.length >= 2) return;

    const { layerId, node, wasDraggable } = this.pinchState;
    this.pinchState = null;
    node.draggable(wasDraggable);
    this.bakeAndCommitTransform(layerId, node);
  };

  // ---- selection bounds (drives the floating trash/duplicate toolbar) ----

  private emitSelectionBounds(): void {
    if (!this.options.onSelectionBoundsChange) return;
    if (!this.selectedLayerId || this.transformer.nodes().length === 0) {
      this.options.onSelectionBoundsChange(null);
      return;
    }
    // Transformer.getClientRect() takes no relativeTo option — unlike
    // Node.getClientRect(), it always returns coordinates in the Stage's own
    // coordinate space, which is exactly stage-local pixels here since this
    // stage is never panned, scaled, or offset.
    const rect = this.transformer.getClientRect();
    this.options.onSelectionBoundsChange({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }

  // ---- text editing (Phase 3, reused by Phase 5's double-tap) ------------

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
    this.detachPinchGestures();
    this.resizeObserver?.disconnect();
    this.unsubscribe();
    this.stage.destroy();
  }
}
