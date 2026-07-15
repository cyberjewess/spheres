import { describe, it, expect } from "vitest";
import { get } from "svelte/store";
import { createEditorStore } from "./editorStore";

describe("editorStore", () => {
  it("starts empty with no layers and nothing selected", () => {
    const store = createEditorStore();
    const state = get(store);
    expect(state.layers).toEqual([]);
    expect(state.selectedLayerId).toBeNull();
    expect(get(store.canUndo)).toBe(false);
    expect(get(store.canRedo)).toBe(false);
  });

  it("addTextLayer appends a text layer, selects it, and is undoable", () => {
    const store = createEditorStore();
    const id = store.addTextLayer({ x: 10, y: 20, width: 200 });

    const state = get(store);
    expect(state.layers).toHaveLength(1);
    expect(state.layers[0]).toMatchObject({
      id,
      type: "text",
      x: 10,
      y: 20,
      width: 200,
      zIndex: 0,
    });
    expect(state.selectedLayerId).toBe(id);
    expect(get(store.canUndo)).toBe(true);
  });

  it("addImageLayer appends an image layer with the given geometry", () => {
    const store = createEditorStore();
    const id = store.addImageLayer("blob:fake-src", {
      x: 5,
      y: 5,
      width: 100,
      height: 150,
    });

    const state = get(store);
    expect(state.layers).toEqual([
      {
        id,
        type: "image",
        src: "blob:fake-src",
        x: 5,
        y: 5,
        width: 100,
        height: 150,
        rotation: 0,
        zIndex: 0,
      },
    ]);
  });

  it("updateLayer patches fields on the matching layer only", () => {
    const store = createEditorStore();
    const id1 = store.addTextLayer({ x: 0, y: 0, width: 100 });
    const id2 = store.addTextLayer({ x: 0, y: 0, width: 100 });

    store.updateLayer(id1, { x: 42, rotation: 15 });

    const state = get(store);
    const layer1 = state.layers.find((l) => l.id === id1);
    const layer2 = state.layers.find((l) => l.id === id2);
    expect(layer1).toMatchObject({ x: 42, rotation: 15 });
    expect(layer2).toMatchObject({ x: 0, rotation: 0 });
  });

  it("deleteLayer removes the layer and renumbers zIndex, clearing selection if it was selected", () => {
    const store = createEditorStore();
    const id1 = store.addTextLayer({ x: 0, y: 0, width: 100 });
    const id2 = store.addTextLayer({ x: 0, y: 0, width: 100 });
    const id3 = store.addTextLayer({ x: 0, y: 0, width: 100 });
    store.selectLayer(id2);

    store.deleteLayer(id2);

    const state = get(store);
    expect(state.layers.map((l) => l.id)).toEqual([id1, id3]);
    expect(state.layers.map((l) => l.zIndex)).toEqual([0, 1]);
    expect(state.selectedLayerId).toBeNull();
  });

  it("duplicateLayer clones a layer with a new id and offset position", () => {
    const store = createEditorStore();
    const id = store.addTextLayer({ x: 10, y: 10, width: 100, text: "hi" });

    const newId = store.duplicateLayer(id);

    const state = get(store);
    expect(newId).not.toBeNull();
    expect(newId).not.toBe(id);
    expect(state.layers).toHaveLength(2);
    const copy = state.layers.find((l) => l.id === newId);
    expect(copy).toMatchObject({ x: 30, y: 30, text: "hi" });
    expect(state.selectedLayerId).toBe(newId);
  });

  it("reorderLayer moves a layer to a new index and renumbers zIndex for all", () => {
    const store = createEditorStore();
    const idA = store.addTextLayer({ x: 0, y: 0, width: 100, text: "A" });
    const idB = store.addTextLayer({ x: 0, y: 0, width: 100, text: "B" });
    const idC = store.addTextLayer({ x: 0, y: 0, width: 100, text: "C" });

    // Move A (currently index 0) to the top (index 2).
    store.reorderLayer(idA, 2);

    const state = get(store);
    expect(state.layers.map((l) => l.id)).toEqual([idB, idC, idA]);
    expect(state.layers.map((l) => l.zIndex)).toEqual([0, 1, 2]);
  });

  it("selectLayer does not push undo history", () => {
    const store = createEditorStore();
    const id = store.addTextLayer({ x: 0, y: 0, width: 100 });
    const pastLengthBeforeSelect = get(store.canUndo);

    store.selectLayer(null);
    store.selectLayer(id);

    expect(get(store).selectedLayerId).toBe(id);
    // Undo should still only need one step to get back to the empty state,
    // proving selection changes weren't pushed as separate history entries.
    expect(pastLengthBeforeSelect).toBe(true);
    store.undo();
    expect(get(store).layers).toEqual([]);
  });

  it("undo/redo restore prior and subsequent committed states", () => {
    const store = createEditorStore();
    const id1 = store.addTextLayer({ x: 0, y: 0, width: 100, text: "first" });
    store.addTextLayer({ x: 0, y: 0, width: 100, text: "second" });

    expect(get(store).layers).toHaveLength(2);

    store.undo();
    expect(get(store).layers).toHaveLength(1);
    expect(get(store).layers[0].id).toBe(id1);
    expect(get(store.canRedo)).toBe(true);

    store.undo();
    expect(get(store).layers).toHaveLength(0);
    expect(get(store.canUndo)).toBe(false);

    store.redo();
    expect(get(store).layers).toHaveLength(1);

    store.redo();
    expect(get(store).layers).toHaveLength(2);
    expect(get(store.canRedo)).toBe(false);
  });

  it("a new committed action clears the redo stack", () => {
    const store = createEditorStore();
    store.addTextLayer({ x: 0, y: 0, width: 100, text: "first" });
    store.undo();
    expect(get(store.canRedo)).toBe(true);

    store.addTextLayer({ x: 0, y: 0, width: 100, text: "branched" });

    expect(get(store.canRedo)).toBe(false);
    expect(get(store).layers.map((l) => (l as { text: string }).text)).toEqual([
      "branched",
    ]);
  });
});
