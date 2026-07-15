/**
 * Svelte store for the Story Editor's layer model (Phase 2).
 *
 * This is the serializable source of truth — Konva nodes are the view and
 * are synced from this store on mount/reorder/undo-redo; the store is only
 * ever written back to from Konva on gesture-*end* (drag/transform), never
 * on every frame, to avoid store churn during a drag (see docs/Story Editor.md).
 *
 * Undo/redo is a linear `{ past, present, future }` history of full-state
 * snapshots, pushed only on "committed" actions (add/delete/reorder,
 * transform-end, text-edit-commit) — NOT on selection changes, and NOT on
 * every intermediate frame of a drag/pinch gesture.
 */

import { derived, writable, type Readable } from "svelte/store";
import {
  createEmptyEditorState,
  type EditorState,
  type ImageLayer,
  type Layer,
  type TextAlign,
  type TextLayer,
} from "./types";

interface History {
  past: EditorState[];
  present: EditorState;
  future: EditorState[];
}

/** Cheap, dependency-free deep clone — state at this scale is tiny (a handful of layers). */
function deepClone<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Works in both the browser and Node/vitest (Node 19+ / most modern browsers). */
export function generateId(): string {
  const g = globalThis as { crypto?: Crypto };
  if (g.crypto && typeof g.crypto.randomUUID === "function") {
    return g.crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Reassigns zIndex to match array order (0 = bottom-most) — call after any structural change. */
function normalizeZIndex(layers: Layer[]): Layer[] {
  return layers.map((layer, index) => ({ ...layer, zIndex: index }));
}

const MAX_HISTORY = 50;

export function createEditorStore(initial: EditorState = createEmptyEditorState()) {
  const history = writable<History>({ past: [], present: initial, future: [] });

  /** Apply a mutator to a clone of `present`, pushing the previous `present` onto `past`. */
  function commit(mutate: (draft: EditorState) => EditorState): void {
    history.update((h) => {
      const draft = deepClone(h.present);
      const next = mutate(draft);
      const past = [...h.past, h.present].slice(-MAX_HISTORY);
      return { past, present: next, future: [] };
    });
  }

  /** Mutate `present` directly without touching undo history — for selection only. */
  function mutateWithoutHistory(mutate: (draft: EditorState) => EditorState): void {
    history.update((h) => ({ ...h, present: mutate(deepClone(h.present)) }));
  }

  function findLayer(state: EditorState, id: string): Layer | undefined {
    return state.layers.find((l) => l.id === id);
  }

  const store = {
    subscribe: derived(history, (h) => h.present).subscribe,

    canUndo: derived(history, (h) => h.past.length > 0) as Readable<boolean>,
    canRedo: derived(history, (h) => h.future.length > 0) as Readable<boolean>,

    undo(): void {
      history.update((h) => {
        if (h.past.length === 0) return h;
        const previous = h.past[h.past.length - 1];
        const past = h.past.slice(0, -1);
        return { past, present: previous, future: [h.present, ...h.future] };
      });
    },

    redo(): void {
      history.update((h) => {
        if (h.future.length === 0) return h;
        const [next, ...rest] = h.future;
        return { past: [...h.past, h.present], present: next, future: rest };
      });
    },

    setBaseImage(src: string, width: number, height: number): void {
      commit((draft) => ({
        ...draft,
        baseImage: src,
        baseImageWidth: width,
        baseImageHeight: height,
      }));
    },

    addImageLayer(
      src: string,
      opts: { x: number; y: number; width: number; height: number },
    ): string {
      const id = generateId();
      commit((draft) => {
        const layer: ImageLayer = {
          id,
          type: "image",
          src,
          x: opts.x,
          y: opts.y,
          width: opts.width,
          height: opts.height,
          rotation: 0,
          zIndex: draft.layers.length,
        };
        return { ...draft, layers: [...draft.layers, layer], selectedLayerId: id };
      });
      return id;
    },

    addTextLayer(opts: {
      x: number;
      y: number;
      width: number;
      text?: string;
      fontFamily?: string;
      fontSize?: number;
      color?: string;
      align?: TextAlign;
    }): string {
      const id = generateId();
      commit((draft) => {
        const layer: TextLayer = {
          id,
          type: "text",
          x: opts.x,
          y: opts.y,
          width: opts.width,
          rotation: 0,
          zIndex: draft.layers.length,
          text: opts.text ?? "Tap to edit",
          fontFamily: opts.fontFamily ?? "Poppins",
          fontSize: opts.fontSize ?? 48,
          color: opts.color ?? "#ffffff",
          align: opts.align ?? "center",
        };
        return { ...draft, layers: [...draft.layers, layer], selectedLayerId: id };
      });
      return id;
    },

    /** Commit a patch to a layer (used on dragend/transformend/text-edit-commit). */
    updateLayer(id: string, patch: Partial<Layer>): void {
      commit((draft) => ({
        ...draft,
        layers: draft.layers.map((l) =>
          l.id === id ? ({ ...l, ...patch } as Layer) : l,
        ),
      }));
    },

    deleteLayer(id: string): void {
      commit((draft) => ({
        ...draft,
        layers: normalizeZIndex(draft.layers.filter((l) => l.id !== id)),
        selectedLayerId: draft.selectedLayerId === id ? null : draft.selectedLayerId,
      }));
    },

    duplicateLayer(id: string): string | null {
      let newId: string | null = null;
      commit((draft) => {
        const source = findLayer(draft, id);
        if (!source) return draft;
        newId = generateId();
        const copy: Layer = {
          ...source,
          id: newId,
          x: source.x + 20,
          y: source.y + 20,
          zIndex: draft.layers.length,
        };
        return {
          ...draft,
          layers: [...draft.layers, copy],
          selectedLayerId: newId,
        };
      });
      return newId;
    },

    /** Move the layer at `id` to `newIndex` in the stack (0 = bottom-most) and renumber zIndex. */
    reorderLayer(id: string, newIndex: number): void {
      commit((draft) => {
        const layers = [...draft.layers];
        const fromIndex = layers.findIndex((l) => l.id === id);
        if (fromIndex === -1) return draft;
        const clampedIndex = Math.max(0, Math.min(newIndex, layers.length - 1));
        const [moved] = layers.splice(fromIndex, 1);
        layers.splice(clampedIndex, 0, moved);
        return { ...draft, layers: normalizeZIndex(layers) };
      });
    },

    /** Selection is NOT part of undo history. */
    selectLayer(id: string | null): void {
      mutateWithoutHistory((draft) => ({ ...draft, selectedLayerId: id }));
    },

    reset(next: EditorState = createEmptyEditorState()): void {
      history.set({ past: [], present: next, future: [] });
    },
  };

  return store;
}

export type EditorStore = ReturnType<typeof createEditorStore>;
