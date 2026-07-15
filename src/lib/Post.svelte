<script lang="ts">
  import Button from "./components/Button.svelte";

  export let owned: boolean;
  export let author: string;
  export let title: string;
  export let content: string | null = null;
  export let id: number;
  export let sphereName: string;
  export let imageUrl: string | null = null;
</script>

<div class="outer">
  <article>
    <p class="sphere">{sphereName}</p>
    <h4 class="author">{author}</h4>
    {#if imageUrl}
      <div class="image-card">
        <img src={imageUrl} alt={title} loading="lazy" />
        <div class="overlay">
          <h3>{title}</h3>
          {#if content}
            <p>{content}</p>
          {/if}
        </div>
      </div>
    {:else}
      <h3>{title}</h3>
      {#if content}
        <p>{content}</p>
      {/if}
    {/if}
    {#if owned}
      <form action="?/deletePost&id={id}" method="POST">
        <Button type="submit" text="Delete" />
      </form>
      <div class="edit">
        <a href="/{id}" role="button">Edit</a>
      </div>
    {/if}
  </article>
</div>

<style>
  .outer {
    display: flex;
    border-color: black;
    border-style: solid;
    border-bottom: 0;
    width: 60%;
    margin: 0 auto;
  }

  article {
    margin: 0 auto;
  }

  form {
    display: flex;
  }

  .edit {
    text-align: center;
  }

  .sphere,
  .author {
    margin: 0.2em 0;
  }

  .image-card {
    position: relative;
    width: 100%;
    border-radius: 12px;
    overflow: hidden;
    margin: 0.5em 0;
  }

  .image-card img {
    display: block;
    width: 100%;
    max-height: 480px;
    object-fit: cover;
  }

  .image-card .overlay {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 0.75em 1em 0.6em;
    background: linear-gradient(
      to top,
      rgba(0, 0, 0, 0.8),
      rgba(0, 0, 0, 0)
    );
    color: white;
  }

  .image-card .overlay h3 {
    margin: 0 0 0.2em;
  }

  .image-card .overlay p {
    margin: 0;
    font-size: 0.9em;
    opacity: 0.9;
  }
</style>
