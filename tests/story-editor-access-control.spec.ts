import { expect, test, type APIResponse } from "@playwright/test";

/**
 * Regression test for the broken-access-control bug found in adversarial
 * review: createStoryPost previously accepted any `sphere` id from form
 * data with no check that it belonged to the requesting user. Verifies a
 * user cannot post into a Sphere owned by someone else, and that a
 * non-Vercel-Blob imageUrl is rejected.
 *
 * Note on response shape: `page.request.post()` is a fetch-style call, so
 * SvelteKit responds with a JSON envelope (`{"type":"failure","status":N,...}`)
 * at HTTP 200 for a `fail()` result -- it only returns a raw HTTP status code
 * for a genuine full-page browser form navigation, not a fetch/XHR request.
 * Assert on the envelope's `type`/`status` fields, not `response.status()`.
 */

async function expectActionFailure(response: APIResponse, expectedStatus: number) {
  const body = JSON.parse(await response.text());
  expect(body.type).toBe("failure");
  expect(body.status).toBe(expectedStatus);
}

async function signUp(page: import("@playwright/test").Page, username: string) {
  const email = `${username}@example.com`;
  // /login/signup's load redirects to "/" if a valid session already exists
  // (see src/routes/login/signup/+page.server.ts's checkForActiveSession),
  // so a second signUp() call in the same test needs to log out first or
  // the form is never reached. Harmless no-op if nothing is logged in yet.
  await page.goto("/logout");
  await page.goto("/login/signup");
  await page.locator("#username").fill(username);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill("test-password-123");
  await page.getByRole("button", { name: "Submit" }).click();
  await page.waitForURL("/");
}

test("createStoryPost rejects a Sphere id the requester doesn't own", async ({ page }) => {
  const unique = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  // User A creates a sphere.
  await signUp(page, `access_a_${unique}`);
  await page.goto("/origin");
  await page.locator("#name").fill(`Private Sphere ${unique}`);
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForLoadState("networkidle");

  await page.goto("/origin/create-story");
  const sphereOption = page.locator("select[name='sphere'] option", {
    hasText: `Private Sphere ${unique}`,
  });
  const sphereAId = await sphereOption.getAttribute("value");
  expect(sphereAId).toBeTruthy();

  // User B (a fresh session -- signing up replaces the session cookie in
  // this same browser context) tries to post directly into User A's Sphere.
  await signUp(page, `access_b_${unique}`);

  // SvelteKit rejects cross-site POSTs by checking the Origin header;
  // page.request.post() doesn't send one by default (unlike a real browser
  // form submission), so it must be set explicitly to reach the actual
  // action code under test rather than being blocked by CSRF protection.
  const response = await page.request.post("/origin/create-story?/createStoryPost", {
    headers: { origin: "http://localhost:4173" },
    form: {
      sphere: sphereAId!,
      title: "Injected post",
      imageUrl: "https://abc123.public.blob.vercel-storage.com/fake.jpg",
    },
  });

  await expectActionFailure(response, 403);

  const origin = await page.request.get("/origin");
  const originBody = await origin.text();
  expect(originBody).not.toContain("Injected post");
});

test("createStoryPost rejects an imageUrl that isn't our own storage domain", async ({
  page,
}) => {
  const unique = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await signUp(page, `access_c_${unique}`);
  await page.goto("/origin");
  await page.locator("#name").fill(`Sphere ${unique}`);
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForLoadState("networkidle");

  await page.goto("/origin/create-story");
  const sphereOption = page.locator("select[name='sphere'] option").first();
  const sphereId = await sphereOption.getAttribute("value");

  const response = await page.request.post("/origin/create-story?/createStoryPost", {
    headers: { origin: "http://localhost:4173" },
    form: {
      sphere: sphereId!,
      title: "Tracking pixel",
      imageUrl: "https://evil.example/tracker.png",
    },
  });

  await expectActionFailure(response, 400);
});
