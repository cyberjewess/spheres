import { prisma } from "$lib/server/prisma";
import { error, fail, type Actions } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, locals }) => {
  const getPost = async () => {
    const post = await prisma.post.findUnique({
      where: {
        id: Number(params.postId),
      },
    });

    if (!post) {
      throw error(404, "Post not found");
    }
    return post;
  };

  const post = await getPost();

  // Only the owning user may view (and, via the form on this page, edit)
  // a post — same ownership rule `Post.svelte` uses to decide whether to
  // even show the "Edit" link (`owned`), enforced here server-side since a
  // client can navigate straight to this route by URL regardless of that
  // UI hint.
  let user;
  try {
    user = await prisma.user.findUniqueOrThrow({
      where: { name: locals.username },
    });
  } catch (err) {
    console.error("[postId] load: could not resolve current user: " + err);
    throw error(403, "You don't have permission to view this post.");
  }
  if (post.userId !== user.id) {
    throw error(403, "You don't have permission to view this post.");
  }

  return { post };
};

export const actions: Actions = {
  updatePost: async ({ request, params, locals }) => {
    const { title, content } = Object.fromEntries(await request.formData()) as {
      title: string;
      content: string;
    };

    // Two-step user lookup (locals.username -> user.id), same pattern as
    // origin/+page.server.ts's createPost / create-story/+page.server.ts's
    // createStoryPost actions.
    let user;
    try {
      user = await prisma.user.findUniqueOrThrow({
        where: { name: locals.username },
      });
    } catch (err) {
      console.error("updatePost: could not resolve current user: " + err);
      return fail(401, { message: "You must be logged in to edit a post." });
    }

    const postId = Number(params.postId);
    const existingPost = await prisma.post.findUnique({ where: { id: postId } });
    if (!existingPost) {
      return fail(404, { message: "Post not found" });
    }
    if (existingPost.userId !== user.id) {
      return fail(403, { message: "You don't have permission to edit this post." });
    }

    try {
      await prisma.post.update({
        where: {
          id: postId,
        },
        data: {
          title,
          content,
        },
      });
    } catch (err) {
      console.error(err);
      return fail(500, { message: "Could not update article" });
    }

    return { status: 200 };
  },
};
