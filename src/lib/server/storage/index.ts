/**
 * Single import point for image storage. The rest of the app should import
 * `storage` from here — never a provider SDK, and never a specific adapter
 * module — so that swapping providers later (Cloudflare R2, S3, Cloudinary,
 * ...) is a one-line change: write a new adapter implementing
 * `StorageAdapter` and re-export it here instead of `vercelBlobAdapter`.
 */
export type {
  StorageAdapter,
  UploadConstraints,
  CompletedUpload,
  HandleClientUploadRequestArgs,
} from "./types";
export { vercelBlobAdapter as storage } from "./vercelBlobAdapter";
