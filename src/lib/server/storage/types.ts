/**
 * Storage-adapter interface — the one seam between the app and whatever
 * image-storage provider is in use (Vercel Blob today; Cloudflare R2, S3,
 * Cloudinary, etc. later). Everything else in the app (routes, form actions,
 * components) must depend only on this interface — imported from
 * `src/lib/server/storage/index.ts`, never on a provider SDK directly.
 *
 * The shape mirrors Vercel Blob's *client-direct* upload flow, since that's
 * the flow we're building against first (browser uploads straight to the
 * blob store, bypassing Vercel's serverless request-body size cap):
 *
 *   1. Browser calls the provider's `upload()` client helper, which POSTs a
 *      small JSON body to our own server route (not to the provider).
 *   2. That route calls `StorageAdapter.handleClientUploadRequest`, passing
 *      through the parsed request body and the raw `Request`. On the first
 *      call (token-request leg) the adapter invokes `onBeforeUpload` so the
 *      app can authorize the upload (e.g. require a logged-in user) and
 *      constrain it (allowed content types, max size), then returns a
 *      JSON-serializable payload (e.g. a short-lived client token) that the
 *      route hands back to the browser verbatim. The browser then streams
 *      the file straight to the blob store — our server never sees the
 *      bytes.
 *   3. When the upload finishes, the provider calls the same route again
 *      (a webhook-style callback) with the completed-upload event. The
 *      adapter invokes `onUploadCompleted` with the final public URL so the
 *      app can persist it (e.g. save it on a Post row), and returns another
 *      JSON-serializable ack payload for the route to send back.
 *
 * A future presigned-URL adapter (R2/S3) can implement the same method by
 * doing its own auth check via `onBeforeUpload` and returning a presigned
 * PUT URL instead of a client token — callers don't need to know which.
 */

/**
 * Constraints the app wants applied to a single upload attempt. Returned
 * from `onBeforeUpload` so the adapter can bake them into whatever
 * short-lived credential it hands the browser (a client token for Vercel
 * Blob; provider-specific policy fields for a future presigned-URL adapter).
 */
export interface UploadConstraints {
  /** MIME types allowed for this upload, e.g. ["image/png", "image/jpeg"]. Wildcards like "image/*" are supported by the Vercel adapter. */
  allowedContentTypes?: string[];
  /** Maximum allowed upload size, in bytes. */
  maximumSizeInBytes?: number;
}

/** Info about a completed upload, passed to `onUploadCompleted`. */
export interface CompletedUpload {
  /** The public URL to store (e.g. in the `Post.imageUrl` column). */
  url: string;
  /** The path/key the file was stored under within the provider. */
  pathname: string;
}

export interface HandleClientUploadRequestArgs {
  /** Parsed JSON body of the POST from the browser's client-side upload call. */
  body: unknown;
  /** The incoming web-standard `Request` (providers may need headers/cookies for verification). */
  request: Request;
  /**
   * Called once per upload attempt, before the browser is authorized to
   * upload. Throw to reject the upload (e.g. the user isn't logged in).
   * Return constraints to apply to this specific upload.
   */
  onBeforeUpload: (
    pathname: string,
    clientPayload: string | null,
  ) => Promise<UploadConstraints> | UploadConstraints;
  /**
   * Called once the browser has finished uploading directly to the store.
   * Use this to persist the final public URL. Optional because some routes
   * (e.g. ones that get the URL back from the client `upload()` call
   * directly) may not need a server-side completion hook.
   */
  onUploadCompleted?: (info: CompletedUpload) => Promise<void> | void;
}

export interface StorageAdapter {
  /**
   * Handles a single POST to the app's upload route from the browser's
   * client-upload call. Returns a JSON-serializable body — the route should
   * send it back to the browser exactly as returned, unmodified.
   */
  handleClientUploadRequest(args: HandleClientUploadRequestArgs): Promise<unknown>;

  /** Deletes a previously-uploaded image, given its public URL. */
  deleteImage(url: string): Promise<void>;
}
