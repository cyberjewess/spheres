<script>
  import "$lib/fonts.css";
</script>

<slot />

<style lang="scss">
  :global(body) {
    width: 90%;
    margin: 0 auto;

    font-family: sans-serif;

    background-color: #1d3040;
    color: #bfc2c7;

    transition: background-color 0.3s;

    scrollbar-color: lightblue rgb(24, 100, 114);
    scrollbar-width: thin;
  }

  :global(a) {
    color: rgb(176, 220, 226);
    text-decoration: none;

    &:visited {
      text-decoration: none;
      opacity: 0.42;
    }
    &:hover {
      opacity: 0.7;
      text-decoration: underline;
    }
    &:active {
      opacity: 1;
      text-decoration: none;
    }
  }

  :global(body.light-mode) {
    background-color: #f2eee2;
    color: #0084f6;
  }
</style>
