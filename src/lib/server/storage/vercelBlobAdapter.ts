import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { del } from "@vercel/blob";
import type { StorageAdapter, HandleClientUploadRequestArgs } from "./types";

/**
 * Vercel Blob implementation of `StorageAdapter`. This is the ONLY file in
 * the app that should import from `@vercel/blob` directly — everything else
 * must go through `StorageAdapter` (see `./index.ts`).
 *
 * Uses Vercel Blob's client-direct-upload flow:
 * https://vercel.com/docs/vercel-blob/client-upload
 *
 * Requires `BLOB_READ_WRITE_TOKEN` in the environment (defaults to reading
 * it from `process.env` automatically when deployed on Vercel; for local
 * dev, pull it with `vercel env pull`).
 */
export const vercelBlobAdapter: StorageAdapter = {
  async handleClientUploadRequest({
    body,
    request,
    onBeforeUpload,
    onUploadCompleted,
  }: HandleClientUploadRequestArgs): Promise<unknown> {
    return handleUpload({
      body: body as HandleUploadBody,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const constraints = await onBeforeUpload(pathname, clientPayload);
        return constraints;
      },
      onUploadCompleted: onUploadCompleted
        ? async ({ blob }) => {
            await onUploadCompleted({ url: blob.url, pathname: blob.pathname });
          }
        : undefined,
    });
  },

  async deleteImage(url: string): Promise<void> {
    await del(url);
  },
};
