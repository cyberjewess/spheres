import { prisma } from "$lib/server/prisma";
import { fail, redirect, type Actions } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

/**
 * Story editor route. The sphere picker only needs to know which Spheres
 * the current user owns (same set `CreatePostForm` is handed on `/origin`),
 * not their whole feed.
 */
export const load: PageServerLoad = async ({ locals }) => {
  const user = await prisma.user.findUniqueOrThrow({
    where: { name: locals.username },
  });

  return {
    username: locals.username,
    userSpheres: await prisma.sphere.findMany({
      where: { userId: user.id },
    }),
  };
};

export const actions: Actions = {
  /**
   * Creates the final Post once the story has been flattened to a single
   * image and uploaded (see Phase 7 — the client uploads to blob storage
   * first and only then submits this action with the resulting URL).
   */
  createStoryPost: async ({ request, locals }) => {
    const formData = await request.formData();
    const { sphere, title, imageUrl } = Object.fromEntries(formData) as {
      sphere: string;
      title: string;
      imageUrl: string;
    };

    if (!imageUrl) {
      return fail(400, {
        message: "Missing exported image — please try posting again.",
      });
    }
    if (!sphere) {
      return fail(400, { message: "Choose a Sphere to post to." });
    }

    // Two-step user lookup (locals.username -> user.id), same pattern as
    // origin/+page.server.ts's createPost action. Deliberately NOT the
    // hardcoded `userId: 1` bug in [postId]/+page.server.ts's updatePost.
    let user;
    try {
      user = await prisma.user.findUniqueOrThrow({
        where: { name: locals.username },
      });
    } catch (err) {
      console.error("createStoryPost: could not resolve current user: " + err);
      return fail(401, { message: "You must be logged in to post." });
    }

    try {
      await prisma.post.create({
        data: {
          title: title || "Story",
          imageUrl,
          userId: user.id,
          sphereId: Number(sphere),
        },
      });
    } catch (err) {
      console.error("createStoryPost: failed to create post: " + err);
      return fail(500, {
        message: "Something went wrong posting your story.",
      });
    }

    throw redirect(303, "/origin");
  },
};
