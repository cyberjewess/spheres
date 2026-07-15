---
tags:
  - feature
---

Instagram-Stories-style post composer: pick a base photo, stack text and image layers on top, drag/resize/rotate each one, then flatten to a single image and post it to a Sphere. Mobile-first — most usage will be through a phone browser.

Today `Post` is text-only (`title`, `content` — see `prisma/schema.prisma`) and there is no image upload, canvas, or blob storage anywhere in the repo. This is a greenfield feature, not an extension of an existing pattern.

# Tech approach (decided)

- **Rendering: Konva.js** (canvas scene graph), not DOM+CSS-transform flattened with html2canvas/dom-to-image. Konva gives native drag/resize/rotate via `Konva.Transformer` and exports the exact same draw calls it renders on screen (`stage.toBlob()`), so there's no separate "flatten the DOM" step that can drift from what the user saw (fonts, gradients, Safari quirks are the usual culprits there).
- **Svelte binding: pin `svelte-konva@0.3.1`.** The `^1.x` line of `svelte-konva` is runes-only and requires Svelte 5 — this app is Svelte 4, so installing latest would break. If the wrapper's reactivity fights the 60fps gesture updates during drag/pinch, fall back to driving vanilla Konva imperatively in `onMount`/`onDestroy` and use Svelte stores only as the serializable model (synced on gesture-end, not every frame).
- **Storage: Vercel Blob**, client-direct upload. Avoids Vercel's 4.5MB serverless request-body cap and gives a CDN URL to store in Postgres, instead of base64-in-column bloat.
- **Fonts:** small curated self-hosted OFL (`.woff2`) set (5-8 fonts), not an open Google-Fonts picker. Must gate first draw/export on `document.fonts.ready` / per-font `.load()` — canvas `fillText` silently uses whatever font is loaded *at draw time*, and once exported to pixels a fallback-font render can't be fixed after the fact.
- **Gesture math:** Konva's `Transformer` handles handle-drag resize/rotate out of the box. Two-finger pinch+twist (resize+rotate together, the core IG-story gesture) is not built in — hand-roll it from Konva's documented multi-touch recipe (~50 lines: two-touch distance → scale, two-touch angle → rotation) rather than pulling in Hammer.js (stagnant) or interact.js (fine as a fallback if the hand-rolled math is too fiddly).
- **Bundle:** Konva is ~50KB gzipped — keep it out of the main bundle by importing only inside the editor route's component (or dynamic `import()` in `onMount`), guarded by `browser` from `$app/environment` (it's canvas/`window`-dependent, so it must be client-only anyway).

# TODO

## Phase 0 — foundations
- [ ] Add dependencies: `konva`, `svelte-konva@0.3.1` (pinned, not `^1`), `@vercel/blob`
- [ ] Set up Vercel Blob: add `BLOB_READ_WRITE_TOKEN` to env (dev + Vercel project), document in README alongside the existing `vercel env pull` instructions
- [ ] Prisma: add `imageUrl String` (Blob CDN URL) to `Post`, make `content` optional (`String?`) since a story post may have no separate text content — decide whether Story posts are a new `postType` field on `Post` or reuse the same model with `imageUrl` nullable for text-only posts (recommend: single `Post` model, `imageUrl String?`, keeps `origin` feed queries and `Post.svelte` display simple)
- [ ] Migration: `npx prisma migrate dev` for the schema change; regenerate client
- [ ] Decide on a `draft` JSON column (or skip drafts for v1) — layer-stack state (§ below) is easy to persist later if you want "save and resume editing," but not required for a first cut
- [ ] Pick/license 5-8 fonts (OFL), self-host `.woff2` files in `static/fonts/`, wire up `@font-face`

## Phase 1 — editor shell & route
- [ ] New route `src/routes/origin/create-story/+page.svelte` + `+page.server.ts` (server action needs `locals.username` → userId lookup, following the existing two-step pattern in `origin/+page.server.ts` — do **not** copy the hardcoded `userId: 1` bug from `[postId]/+page.server.ts`'s `updatePost`)
- [ ] Entry point: button/link from `origin` page (alongside `CreatePostForm`) into the story editor, sphere picker reused from existing `CreatePostForm.svelte` pattern (select which Sphere the finished story posts to)
- [ ] Mobile viewport meta tweak scoped to this route only: prevent page-level pinch-zoom fighting the canvas gesture (`user-scalable=no` / `maximum-scale=1` on this route, not app-wide)
- [ ] Editor container sized with `100dvh` (not `100vh` — iOS Safari's dynamic toolbar makes `100vh` unreliable), `touch-action: none` on the stage wrapper so Konva's own touch handling isn't fought by native scroll/zoom

## Phase 2 — layer model & state
- [ ] Define `Layer` type: `{ id, type: 'image' | 'text', x, y, width, height, rotation, zIndex, ...type-specific fields }` (text adds `text, fontFamily, fontSize, color, align`; image adds `src`)
- [ ] Svelte store holding `{ baseImage, layers: Layer[], selectedLayerId }` as the serializable source of truth — Konva nodes are the view, store is the model; sync store→Konva on mount/reorder, sync Konva→store only on `dragend`/`transformend` (not every frame, to avoid store churn during a drag)
- [ ] Undo/redo: linear `{past, present, future}` history of full-state snapshots, pushed on committed actions (layer add/delete/reorder/transform-end/text-edit-commit) — deep-clone is cheap at this scale, don't reach for patch-based diffing

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
- [ ] Update `src/lib/Post.svelte` to render `imageUrl` when present (image-forward layout, IG-story-card-like) vs the current text-only card
- [ ] `origin` feed and single-post `[postId]` route both need to handle posts with an image

## Phase 9 — testing
- [ ] Fix the currently-stale Playwright test in `tests/test.ts` (asserts the default SvelteKit welcome heading, which no longer matches `+page.svelte`'s "Welcome to Spheres") while touching this area
- [ ] Add a Playwright test for the story-creation happy path (upload base image, add a text layer, delete a layer, export, submit) — no existing auth-mocking test fixture exists in this repo, so this also means building a minimal login-as-test-user helper
- [ ] Unit-test the layer-store reducer logic (add/delete/reorder/undo/redo) in isolation from Konva — `src/index.test.ts` is currently a placeholder smoke test, this would be the first real unit test in the repo

# Open questions
- Should story posts be a distinct `postType` on `Post`, or is "has `imageUrl`" enough to distinguish a story post from a text post in the feed?
- Any max canvas/output resolution target (e.g. matching IG's 1080x1920) vs preserving the source photo's native aspect ratio?
- Drafts: worth persisting in-progress edits (JSON layer state) before final export, or is losing an in-progress edit on navigation acceptable for v1?
