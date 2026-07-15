import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * End-to-end verification of the Story Editor (docs/Story Editor.md), driven
 * through a real signup -> login -> sphere creation -> editor flow against a
 * real Postgres database (not mocked). Exercises: base image pick, adding a
 * text layer and a photo layer, tap-to-select, the floating trash/duplicate
 * toolbar, the layer list, and undo/redo.
 *
 * NOT exercised here: the final "Post" upload step. That requires a real
 * BLOB_READ_WRITE_TOKEN against actual Vercel Blob infrastructure, which
 * isn't available in this environment — see docs/Story Editor.md's open
 * gaps. Everything up to (and including enabling) the Post button is
 * verified; the network upload itself is not.
 */

const FIXTURE_IMAGE = path.join(__dirname, "fixtures", "test-photo.jpg");

test("story editor: create sphere, build a layered story, undo/redo, select/delete", async ({
  page,
}) => {
  const unique = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const username = `story_test_${unique}`;
  const email = `story_test_${unique}@example.com`;
  const password = "test-password-123";

  // ---- sign up + implicit login ------------------------------------------
  await page.goto("/login/signup");
  await page.locator("#username").fill(username);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Submit" }).click();

  await page.waitForURL("/");
  await expect(page.getByRole("heading", { name: "Welcome to Spheres" })).toBeVisible();

  // ---- create a Sphere (the story needs somewhere to post to) ------------
  await page.goto("/origin");
  await page.locator("#name").fill(`Test Sphere ${unique}`);
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForLoadState("networkidle");

  // Note: this is an <a> with an explicit role="button" override in the
  // markup, so its accessible role is "button", not the implicit "link".
  await expect(page.getByRole("button", { name: "+ New Story" })).toBeVisible();

  // ---- into the editor -----------------------------------------------------
  await page.getByRole("button", { name: "+ New Story" }).click();
  await page.waitForURL("**/origin/create-story");

  // The Konva stage mounts asynchronously (dynamic import); wait for its
  // <canvas> before doing anything else.
  await expect(page.locator("#story-stage-wrapper canvas")).toBeVisible();

  // ---- pick the base photo --------------------------------------------------
  // The hidden file input has capture="environment" (a mobile camera hint),
  // which in headless Chromium doesn't reliably fire a native "filechooser"
  // event -- so we click the visible trigger (which synchronously sets the
  // component's pendingFileTarget) and then set files directly on the
  // underlying input, rather than waiting for a filechooser dialog.
  const fileInput = page.locator('input[type="file"]');
  await page.getByRole("button", { name: "Choose photo" }).click();
  await fileInput.setInputFiles(FIXTURE_IMAGE);

  // Base-image picker UI should disappear once a photo is chosen, and the
  // toolbar buttons that require a base image should become enabled.
  await expect(page.getByRole("button", { name: "Choose photo" })).toBeHidden();
  const addTextButton = page.getByRole("button", { name: "Add text layer" });
  const addPhotoLayerButton = page.getByRole("button", { name: "Add photo layer" });
  await expect(addTextButton).toBeEnabled();
  await expect(addPhotoLayerButton).toBeEnabled();

  // ---- add a text layer, type into the edit overlay, commit -----------------
  await addTextButton.click();
  const editOverlay = page.locator("textarea");
  await expect(editOverlay).toBeVisible();
  await editOverlay.fill("Hello Spheres");
  // Blur by clicking the (non-interactive) top bar area, committing the text.
  await page.locator(".top-bar").click({ position: { x: 10, y: 10 } });
  await expect(editOverlay).toBeHidden();

  // ---- layer list shows the new text layer -----------------------------------
  const layersToggle = page.getByRole("button", { name: "Layers" });
  await expect(layersToggle).toBeEnabled();
  await layersToggle.click();
  const layerRows = page.locator("[data-layer-row]");
  await expect(layerRows).toHaveCount(1);
  await expect(layerRows.first()).toContainText("Hello Spheres");

  // ---- add a second layer (a photo layer) ------------------------------------
  await addPhotoLayerButton.click();
  await fileInput.setInputFiles(FIXTURE_IMAGE);
  await expect(layerRows).toHaveCount(2);

  // ---- select the frontmost layer (top row) -> floating toolbar appears -----
  await layerRows.first().click();
  const trashButton = page.getByRole("button", { name: "Delete layer" });
  const duplicateButton = page.getByRole("button", { name: "Duplicate layer" });
  await expect(trashButton).toBeVisible();
  await expect(duplicateButton).toBeVisible();

  // ---- delete it via the trash icon -- the core "easily remove any layer" ---
  await trashButton.click();
  await expect(layerRows).toHaveCount(1);
  // Floating toolbar should disappear once nothing is selected.
  await expect(trashButton).toBeHidden();

  // ---- undo restores the deleted layer, redo removes it again ----------------
  const undoButton = page.getByRole("button", { name: "Undo" });
  const redoButton = page.getByRole("button", { name: "Redo" });
  await expect(undoButton).toBeEnabled();
  await undoButton.click();
  await expect(layerRows).toHaveCount(2);

  await expect(redoButton).toBeEnabled();
  await redoButton.click();
  await expect(layerRows).toHaveCount(1);

  // ---- Post button reaches an enabled, submittable state ---------------------
  // (The network upload itself needs a real Vercel Blob token, which this
  // environment doesn't have -- see the doc's open gaps. We verify the
  // button is reachable and enabled, not the upload/redirect.)
  const postButton = page.getByRole("button", { name: "Post" });
  await expect(postButton).toBeEnabled();
});
