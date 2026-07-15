/**
 * Loads a picked `File` (base photo or an added photo layer) as an in-session
 * object URL + a decoded `HTMLImageElement`, without touching the network or
 * blob storage — nothing is uploaded until the final flattened export
 * (Phase 7). Client-only; never called during SSR.
 */
export interface LoadedImage {
  /** Object URL — valid for this browser tab's lifetime. */
  url: string;
  width: number;
  height: number;
  image: HTMLImageElement;
}

export function loadImageFile(file: File): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new window.Image();
    image.onload = () => {
      resolve({ url, width: image.naturalWidth, height: image.naturalHeight, image });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not load that image."));
    };
    image.src = url;
  });
}
