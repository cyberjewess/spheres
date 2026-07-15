import type { Actions } from "./$types";
import { prisma } from "$lib/server/prisma";
import { storage } from "$lib/server/storage";
import { fail } from "@sveltejs/kit";

/** @type {import('./$types').PageLoad} */
export const load = async ({ locals }) => {
  let user = await prisma.user.findUniqueOrThrow({
    where: { name: locals.username },
  });
  if (!user) {
    return { username: locals.username };
  }

  return {
    username: locals.username,
    userSpheres: await prisma.sphere.findMany({
      where: { userId: user.id },
      include: {
        posts: {
          orderBy: [{ createTime: "desc" }],
        },
      },
    }),
    allowedSpheres: await prisma.user.findUnique({
      where: { id: user.id },
      include: {
        allowedSpheres: {
          include: {
            posts: {
              include: { user: true },
              orderBy: [{ createTime: "desc" }],
            },
          },
        },
      },
    }),
    posts: await prisma.post.findMany({ where: { userId: user.id } }),
  };
};

export const actions: Actions = {
  createPost: async ({ request, locals }) => {
    console.log("createPost called");
    const formData = await request.formData();
    const { sphere, title, content } = Object.fromEntries(formData) as {
      sphere: string;
      title: string;
      content: string;
    };
    console.log("sphereId:" + sphere);

    return await prisma.user
      .findUniqueOrThrow({
        where: { name: locals.username },
      })
      .then(async (user) => {
        return await prisma.post.create({
          data: { title, content, userId: user.id, sphereId: Number(sphere) },
        });
      })
      .then(() => {
        return { status: 201 };
      })
      .catch((err) => {
        let message = "Error creating post: " + err;
        console.error(message);
        return { status: 500, message };
      });
  },

  createSphere: async ({ request, locals }) => {
    console.log("createSphere called");
    const formData = await request.formData();
    const { name, allowList } = Object.fromEntries(formData) as {
      name: string;
      allowList: string;
    };

    return await prisma.user
      .findUniqueOrThrow({ where: { name: locals.username } })
      .then(async (user) => {
        return await prisma.sphere.create({
          data: { name: name, userId: user.id },
        });
      });
  },

  deletePost: async ({ url }) => {
    console.log("deletePost called");
    const id = url.searchParams.get("id");
    if (!id) {
      return fail(500, { message: "invalid request" });
    }
    let deletedPost;
    try {
      // Prisma's delete() return value includes the deleted row's fields, so
      // this also gets us imageUrl without a separate fetch.
      deletedPost = await prisma.post.delete({ where: { id: Number(id) } });
    } catch (err) {
      console.error(err);
      return fail(500, {
        message: "Something went wrong deleting your article",
      });
    }

    if (deletedPost.imageUrl) {
      // Best-effort: don't let a storage-provider hiccup block the Post row
      // deletion the user asked for, which already succeeded above.
      try {
        await storage.deleteImage(deletedPost.imageUrl);
      } catch (err) {
        console.error("deletePost: failed to delete underlying image blob: " + err);
      }
    }

    return { status: 200 };
  },
};
