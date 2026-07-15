<script lang="ts">
  import EditPostForm from "$lib/EditPostForm.svelte";
  import Navbar from "$lib/Navbar.svelte";
  import type { PageData } from "./$types";
  export let data: PageData;
  $: ({ post } = data);
</script>

<Navbar />
<main>
  <EditPostForm title={post.title} content={post.content} imageUrl={post.imageUrl} />
</main>
