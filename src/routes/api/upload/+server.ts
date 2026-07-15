import { storage } from "$lib/server/storage";
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

/**
 * Client-direct-upload endpoint for the Story Editor's flattened export
 * (Phase 7). The browser's `upload()` helper (from `@vercel/blob/client`)
 * POSTs here twice — see `src/lib/server/storage/types.ts` for the full
 * two-call contract this mirrors:
 *
 *   1. Token request: `onBeforeUpload` below runs first and must throw to
 *      reject the upload — this is the auth gate, requiring a logged-in
 *      user (`locals.username`) before anyone gets a client token.
 *   2. Completion callback: once the browser finishes streaming the file
 *      straight to Vercel Blob, the same route is called again to report
 *      the final URL (not used here — the client already gets the URL back
 *      directly from its own `upload()` call and passes it to the
 *      `createStoryPost` form action itself).
 *
 * Only imports `storage` from `$lib/server/storage` — never `@vercel/blob`
 * directly, per the storage-adapter abstraction (Phase 0).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  const body = await request.json();

  try {
    const result = await storage.handleClientUploadRequest({
      body,
      request,
      onBeforeUpload: async () => {
        if (!locals.username) {
          throw new Error("You must be logged in to upload an image.");
        }
        return {
          allowedContentTypes: ["image/jpeg", "image/png", "image/webp"],
          maximumSizeInBytes: 15 * 1024 * 1024, // 15MB — comfortably covers a pixelRatio-3 export
        };
      },
    });
    return json(result);
  } catch (err) {
    console.error("upload route error: " + err);
    const message = err instanceof Error ? err.message : "Upload failed";
    throw error(400, message);
  }
};
