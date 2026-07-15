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

## Phase 3 — base image + adding layers — ✅ done
- [x] Base layer: `<input type="file" accept="image/*" capture="environment">` (hidden, triggered by a "Choose photo" button shown until a base image is picked) loads via `src/lib/story-editor/imageLoader.ts#loadImageFile` (object URL + decoded `HTMLImageElement`, nothing uploaded yet) and lands in the store via `store.setBaseImage(url, width, height)`; the Konva controller contain-fits it as the bottom, non-interactive (`listening: false`) `Konva.Image`, re-fitting on container resize
- [x] "Add photo layer" — same file picker/loader, centered on the current stage size at up to 70% of stage width, added via `store.addImageLayer(...)`
- [x] "Add text layer" — `store.addTextLayer(...)` with a default font/size/color from the new `src/lib/story-editor/fonts.ts` (`DEFAULT_FONT_FAMILY`/`DEFAULT_TEXT_COLOR`), then immediately calls `StoryCanvasController.enterTextEditMode(id)` — Konva's documented editable-text pattern: hide the `Konva.Text` node, overlay a `<textarea>` positioned/sized/rotated/fonted to match it, swap back and commit the text to the store on blur. This same method is reused for double-tap-to-edit in Phase 5.
- [x] Bottom toolbar with add-photo/add-text buttons (disabled until a base image exists) plus Undo/Redo (added now since the store already supports it — cheap, and useful for manually verifying Phase 2's history logic once there's something on screen to undo), `env(safe-area-inset-bottom)` padding

**New files**: `src/lib/story-editor/konvaEditor.ts` (`StoryCanvasController` — the imperative Konva scene, store-driven per the Phase 2 deviation), `src/lib/story-editor/imageLoader.ts`, `src/lib/story-editor/fonts.ts` (curated font list + `ensureFontsLoaded`/`collectFontFacesInUse`, the latter two written now but wired into the export gate in Phase 7).

**Verified the code-splitting goal, not just assumed it**: ran a full `vite build` and inspected `.svelte-kit/output/client/.vite/manifest.json` — `/origin/create-story` maps to `nodes/10`, whose only reference to the ~193KB Konva chunk is a `dynamicImports` entry (from the `import("konva")` inside `StoryCanvasController.create()`). No other route or the main entry chunk references it. Confirms Konva loads lazily, only when this route mounts, never in the shared bundle.

**Known simplification**: on a container resize (e.g. orientation change mid-edit), the base image is re-fit to the new stage size, but existing layers' `x`/`y`/`width` are left as absolute stage-pixel coordinates from whenever they were placed — there's no "design size vs. stage size" proportional reflow. Flagging as a deliberate scope cut rather than an oversight; revisit if orientation changes mid-edit turn out to matter in practice.

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
