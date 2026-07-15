---
tags:
  - feature
---

Instagram-Stories-style post composer: pick a base photo, stack text and image layers on top, drag/resize/rotate each one, then flatten to a single image and post it to a Sphere. Mobile-first — most usage will be through a phone browser.

Today `Post` is text-only (`title`, `content` — see `prisma/schema.prisma`) and there is no image upload, canvas, or blob storage anywhere in the repo. This is a greenfield feature, not an extension of an existing pattern.

# Tech approach (decided)

- **Rendering: Konva.js** (canvas scene graph), not DOM+CSS-transform flattened with html2canvas/dom-to-image. Konva gives native drag/resize/rotate via `Konva.Transformer` and exports the exact same draw calls it renders on screen (`stage.toBlob()`), so there's no separate "flatten the DOM" step that can drift from what the user saw (fonts, gradients, Safari quirks are the usual culprits there).
- **Svelte binding: pin `svelte-konva@0.3.1`.** The `^1.x` line of `svelte-konva` is runes-only and requires Svelte 5 — this app is Svelte 4, so installing latest would break. If the wrapper's reactivity fights the 60fps gesture updates during drag/pinch, fall back to driving vanilla Konva imperatively in `onMount`/`onDestroy` and use Svelte stores only as the serializable model (synced on gesture-end, not every frame).
- **Storage: Vercel Blob** for now, client-direct upload. Avoids Vercel's 4.5MB serverless request-body cap and gives a CDN URL to store in Postgres, instead of base64-in-column bloat. Isolated behind a small storage-adapter interface (see Phase 0) so swapping to R2/S3/Cloudinary later is a new adapter file, not a rewrite.
- **Fonts:** small curated self-hosted OFL (`.woff2`) set (5-8 fonts), not an open Google-Fonts picker. Must gate first draw/export on `document.fonts.ready` / per-font `.load()` — canvas `fillText` silently uses whatever font is loaded *at draw time*, and once exported to pixels a fallback-font render can't be fixed after the fact.
- **Gesture math:** Konva's `Transformer` handles handle-drag resize/rotate out of the box. Two-finger pinch+twist (resize+rotate together, the core IG-story gesture) is not built in — hand-roll it from Konva's documented multi-touch recipe (~50 lines: two-touch distance → scale, two-touch angle → rotation) rather than pulling in Hammer.js (stagnant) or interact.js (fine as a fallback if the hand-rolled math is too fiddly).
- **Bundle:** Konva is ~50KB gzipped — keep it out of the main bundle by importing only inside the editor route's component (or dynamic `import()` in `onMount`), guarded by `browser` from `$app/environment` (it's canvas/`window`-dependent, so it must be client-only anyway).

# TODO

## Phase 0 — foundations
- [x] Add `@vercel/blob` dependency (`^2.6.1`, installed, `package-lock.json` regenerated)
- [ ] Add `konva`, `svelte-konva@0.3.1` (pinned, not `^1`) — still open, needed for Phase 1+
- [ ] Set up Vercel Blob: add `BLOB_READ_WRITE_TOKEN` to env (dev + Vercel project), document in README alongside the existing `vercel env pull` instructions
- [x] **Storage adapter abstraction** — done. `src/lib/server/storage/types.ts` defines `StorageAdapter` (`handleClientUploadRequest`, `deleteImage`) mirroring Vercel Blob's real client-direct-upload flow (checked against the actual `@vercel/blob@2.6.1` types, not guessed); `vercelBlobAdapter.ts` is the only file importing `@vercel/blob`; `index.ts` re-exports it as `storage` — the single import point for the rest of the app. Swapping providers later = new adapter file + one export change.
- [x] Prisma: `imageUrl String?` added to `Post`, `content` made `String?` (single `Post` model, nullable `imageUrl` distinguishes a story post from a text post — see open question below on whether that's sufficient long-term)
- [ ] Migration: hand-written SQL exists at `prisma/migrations/20260715011800_add_image_url_to_post/migration.sql` (no live DB was available to actually run/verify it — ⚠️ **run `npx prisma migrate dev` against a real database to confirm/regenerate before relying on it**). `npx prisma generate` (schema-only, no DB connection needed) has been run so the Prisma Client types include `Post.imageUrl` — required for `create-story/+page.server.ts` to typecheck; the client still needs regenerating again after `migrate dev` actually runs against a real database.
- [ ] Decide on a `draft` JSON column (or skip drafts for v1) — layer-stack state (§ below) is easy to persist later if you want "save and resume editing," but not required for a first cut
- [x] Fonts picked/licensed/self-hosted — 6 families (8 files, ~208KB), all SIL OFL 1.1, sourced from Google Fonts, files in `static/fonts/` + `OFL.txt`/`ATTRIBUTION.txt`, `@font-face` rules in `src/lib/fonts.css`, imported once from root `+layout.svelte`:

  | font-family | Purpose |
  |---|---|
  | `Poppins` (400, 700) | Bold/heavy sans — punchy headline-style captions |
  | `Anton` (400) | Heavy ultra-condensed impact display — big "meme/story" statement text |
  | `Bebas Neue` (400) | Condensed all-caps display — tall, IG-story-style headers |
  | `Caveat` (400, 700) | Handwriting/script — casual, personal-note mood |
  | `Playfair Display` (400, 700) | Serif — elegant/editorial captions |
  | `Space Mono` (400, 700) | Monospace — typewriter/technical caption mood |

## Phase 1 — editor shell & route — ✅ done
- [x] New route `src/routes/origin/create-story/+page.svelte` + `+page.server.ts`. `load` does the two-step `locals.username` → `prisma.user.findUniqueOrThrow` → `.id` lookup, then fetches that user's owned Spheres for the picker. The `createStoryPost` action does the same two-step lookup (not the hardcoded `userId: 1` bug in `[postId]/+page.server.ts`), validates `sphere`/`imageUrl` are present, uses `fail()` for every error path, and `redirect(303, "/origin")` on success. The action is fully wired now even though nothing calls it yet — Phase 7 only needs to add the client-side upload-then-submit flow.
- [x] Entry point: "+ New Story" link on `/origin`, next to `CreatePostForm`, gated behind the same `userSpheresExists` check (posting a story requires an owned Sphere, same precondition as the existing post form)
- [x] Scoped mobile-viewport tweak: `onMount`/`onDestroy` mutate (and restore) the existing root `<meta name="viewport">` tag's `content` in-place instead of editing `src/app.html`, so `user-scalable=no`/`maximum-scale=1` only applies while this route is mounted. Also locks `document.body.style.overflow` for the same duration (restored on destroy) so the page can't scroll behind the full-bleed editor.
- [x] Editor container: `100dvh` height, `position: fixed; inset: 0` (breaks out of the root layout's centered 90%-width body without touching that global stylesheet), `touch-action: none` on the `.stage-wrapper` div that Phase 3 will mount the Konva stage into

**Deviation**: this route deliberately does not render the shared `Navbar` — full-bleed, single-purpose editor screens (matching the IG-story-composer convention) instead get a top-left "×" close link back to `/origin`. Everything else (Sphere picker markup, `fail()` error display) follows existing patterns.

## Phase 2 — layer model & state — ✅ done
- [x] `Layer` discriminated union (`ImageLayer` | `TextLayer`) in `src/lib/story-editor/types.ts`, plus `EditorState`/`createEmptyEditorState()`
- [x] `src/lib/story-editor/editorStore.ts` — `createEditorStore()`: `{past, present, future}` history, `subscribe`/`canUndo`/`canRedo`, and layer ops (`addImageLayer`, `addTextLayer`, `updateLayer`, `deleteLayer`, `duplicateLayer`, `reorderLayer`, `selectLayer`, `undo`/`redo`/`reset`). `zIndex` is array-index-derived and renumbered (`normalizeZIndex`) on every structural change, so array order doubles as render order. `selectLayer` deliberately bypasses undo history (mutates `present` directly) — matches the plan's intent that only "committed" structural actions are undoable, not selection.
- [x] Undo/redo implemented as planned: linear history of full-state snapshots via `structuredClone` (JSON fallback for older environments), capped at 50 entries, pushed only on structural actions
- [x] 10 Vitest unit tests in `editorStore.test.ts` covering add/update/delete/duplicate/reorder/undo/redo/branching — all passing, isolated from Konva entirely (no DOM/canvas needed)

**Deviation from the Phase 0 checklist**: dropped `svelte-konva` from the dependency list. Reasoning (from the Sonnet agent building this): every interaction in Phases 4-7 (hand-rolled pinch/rotate, `Transformer.getClientRect()` for the trash icon, manual z-order, textarea-overlay text editing) needs direct Konva node handles regardless, so `svelte-konva`'s reactive prop-binding would just be a second reactivity system fighting Svelte's and Konva's own for no benefit — this is exactly the fallback the "Tech approach" section above already called out (drive vanilla Konva imperatively via `onMount`/`onDestroy` if the wrapper fights gesture updates). Going straight to the fallback rather than adopting-then-abandoning the wrapper. `konva` itself (not the Svelte wrapper) is added as a dependency.

## Phase 3 — base image + adding layers
- [ ] Base layer: `<input type="file" accept="image/*" capture>` (capture hints camera on mobile) to pick/take the starting photo; load into Konva as the bottom `Konva.Image`
- [ ] "Add photo layer" — same file input, adds a new `Konva.Image` node on top with default centered position/size
- [ ] "Add text layer" — adds a `Konva.Text` node with default font/size/color, immediately enters edit mode (see Phase 5)
- [ ] Bottom toolbar (thumb-reachable) with add-photo / add-text buttons, `env(safe-area-inset-bottom)` padding so it's not obscured by the iOS home-indicator bar

## Phase 4 — transform interactions
- [ ] Tap a layer → select it, attach `Konva.Transformer` to show resize/rotate handles
- [ ] Tap empty canvas → deselect (hide transformer + trash icon) — standard stage-level tap handler checking if target is the background
- [ ] Single-finger drag → move (Konva `draggable: true`, built in)
- [ ] Two-finger pinch+twist → simultaneous resize + rotate (hand-rolled per Konva's multi-touch recipe; register the touchmove listener with `{ passive: false }` so `preventDefault()` actually stops page scroll during the gesture)
- [ ] Floating trash-can icon button positioned above the selected layer's bounding box (derive position from `transformer.getClientRect()`), tap to delete that layer — exactly the "easily remove any layer" requirement
- [ ] Optional: duplicate-layer icon next to trash, common IG-editor convenience

## Phase 5 — text layer specifics
- [ ] Font picker UI (small curated list from Phase 0) — changing font/size while text is selected re-renders the `Konva.Text` node live
- [ ] Double-tap a text layer → edit mode: overlay an absolutely-positioned HTML `<textarea>` matching the node's position/size/rotation/font, swap back to `Konva.Text` on blur (Konva's documented pattern for editable canvas text — contenteditable-in-canvas isn't a thing, this overlay swap is the standard approach, not a workaround)
- [ ] Resize gesture on a text layer adjusts `fontSize` (not just bounding box scale, or text goes blurry/pixelated when scaled as a bitmap)
- [ ] Color picker for text fill; optional background-behind-text toggle (common IG-story convention for readability over busy photos)

## Phase 6 — layer list & reordering
- [ ] Simple layer list (thumbnails or labeled rows, top = frontmost) showing current z-order
- [ ] Long-press + drag a row to reorder → updates `zIndex` in the store → re-sorts Konva layer stack
- [ ] Tapping a row in the list selects that layer on the canvas (same selection state as tapping it directly)

## Phase 7 — export & submit
- [ ] "Done"/"Post" button: before export, verify every font in use is loaded (`document.fonts.check`, await `.load()` for any that aren't) as a last-second guard against a fallback-font export
- [ ] `stage.toBlob({ pixelRatio: capped 2-3x, mimeType: 'image/jpeg', quality })` — keep the *interactive* stage at normal resolution and only bump pixelRatio at export time, to avoid iOS Safari's per-canvas memory ceiling on large stages
- [ ] Upload the blob client-side directly to Vercel Blob (`put()` client-upload flow), get back the CDN URL
- [ ] Submit form action with `{ sphere, imageUrl, title/content? }`, following the existing `createPost` action shape in `origin/+page.server.ts` — use `fail()` consistently for errors (existing code mixes `fail()` and bare `{status, message}` objects; don't propagate that inconsistency into new code)

## Phase 8 — display
- [x] `src/lib/Post.svelte` renders `imageUrl` when present — image-forward card (full-width rounded `<img>`, capped height, `object-fit: cover`) with title/content overlaid via a bottom gradient scrim, IG-story-caption style; falls back to the original plain text layout when `imageUrl` is null
- [x] `origin` feed (`+page.svelte`) and single-post `[postId]` route/`EditPostForm` both pass through and handle `imageUrl` (read-only preview in the edit form; upload control itself is out of scope until the editor exists)

## Phase 9 — testing
- [x] Fixed the stale Playwright test in `tests/test.ts` (was asserting the default SvelteKit welcome heading; now asserts "Welcome to Spheres" matching `+page.svelte`)
- [ ] Add a Playwright test for the story-creation happy path (upload base image, add a text layer, delete a layer, export, submit) — no existing auth-mocking test fixture exists in this repo, so this also means building a minimal login-as-test-user helper
- [ ] Unit-test the layer-store reducer logic (add/delete/reorder/undo/redo) in isolation from Konva — `src/index.test.ts` is currently a placeholder smoke test, this would be the first real unit test in the repo

# Open questions
- Should story posts be a distinct `postType` on `Post`, or is "has `imageUrl`" enough to distinguish a story post from a text post in the feed?
- Any max canvas/output resolution target (e.g. matching IG's 1080x1920) vs preserving the source photo's native aspect ratio?
- Drafts: worth persisting in-progress edits (JSON layer state) before final export, or is losing an in-progress edit on navigation acceptable for v1?
