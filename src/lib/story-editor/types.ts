/**
 * Layer model for the Story Editor. This is the serializable source of
 * truth for the editor — Konva nodes are just the view, rebuilt/synced from
 * this state. See docs/Story Editor.md, Phase 2.
 */

export type TextAlign = "left" | "center" | "right";

interface LayerBase {
  /** Stable id, generated client-side (crypto.randomUUID). */
  id: string;
  x: number;
  y: number;
  /** Degrees. */
  rotation: number;
  /** Stacking order — higher renders on top. Kept in sync with array order. */
  zIndex: number;
}

export interface ImageLayer extends LayerBase {
  type: "image";
  width: number;
  height: number;
  /** Object URL (or data URL) for the in-session image bytes. */
  src: string;
}

export interface TextLayer extends LayerBase {
  type: "text";
  /** Bounding box width; text wraps/reflows within it. */
  width: number;
  text: string;
  fontFamily: string;
  fontSize: number;
  color: string;
  align: TextAlign;
}

export type Layer = ImageLayer | TextLayer;

export interface EditorState {
  /** The bottom-most background photo, if one has been picked yet. */
  baseImage: string | null;
  baseImageWidth: number;
  baseImageHeight: number;
  layers: Layer[];
  selectedLayerId: string | null;
}

export function createEmptyEditorState(): EditorState {
  return {
    baseImage: null,
    baseImageWidth: 0,
    baseImageHeight: 0,
    layers: [],
    selectedLayerId: null,
  };
}
