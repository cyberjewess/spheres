/**
 * The curated font set from Phase 0 (`src/lib/fonts.css`), described here so
 * the editor's font picker (Phase 5) and default text-layer styling (Phase 3)
 * share one source of truth instead of two hand-kept lists.
 */
export interface FontOption {
  /** CSS font-family name — must exactly match an `@font-face` in fonts.css. */
  family: string;
  /** Human-readable label for the font picker. */
  label: string;
  weights: number[];
}

export const FONT_OPTIONS: FontOption[] = [
  { family: "Poppins", label: "Poppins", weights: [400, 700] },
  { family: "Anton", label: "Anton", weights: [400] },
  { family: "Bebas Neue", label: "Bebas Neue", weights: [400] },
  { family: "Caveat", label: "Caveat", weights: [400, 700] },
  { family: "Playfair Display", label: "Playfair Display", weights: [400, 700] },
  { family: "Space Mono", label: "Space Mono", weights: [400, 700] },
];

export const DEFAULT_FONT_FAMILY = "Poppins";
export const DEFAULT_FONT_WEIGHT = 700;
export const DEFAULT_TEXT_COLOR = "#ffffff";

/**
 * Every (family, weight) pair actually used across a set of text layers —
 * used by the Phase 7 export gate to know exactly which fonts must be
 * confirmed loaded before `document.fonts.check`/`.load()`.
 */
export function collectFontFacesInUse(
  layers: { fontFamily?: string; fontSize?: number }[],
): { family: string; cssFontString: string }[] {
  const seen = new Map<string, { family: string; cssFontString: string }>();
  for (const layer of layers) {
    if (!layer.fontFamily) continue;
    const size = layer.fontSize ?? 16;
    const key = `${layer.fontFamily}`;
    if (!seen.has(key)) {
      seen.set(key, {
        family: layer.fontFamily,
        cssFontString: `${DEFAULT_FONT_WEIGHT} ${size}px "${layer.fontFamily}"`,
      });
    }
  }
  return Array.from(seen.values());
}

/**
 * Ensures every font family in use is actually loaded before we draw/export
 * with it — `document.fonts.check`/`fillText` silently fall back to a
 * substitute font otherwise, and a canvas export can't be fixed after the
 * fact once it's flattened to pixels. Safe to call repeatedly.
 */
export async function ensureFontsLoaded(
  layers: { fontFamily?: string; fontSize?: number }[],
): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  await document.fonts.ready;
  const faces = collectFontFacesInUse(layers);
  await Promise.all(
    faces.map(async ({ cssFontString }) => {
      if (!document.fonts.check(cssFontString)) {
        await document.fonts.load(cssFontString);
      }
    }),
  );
}
