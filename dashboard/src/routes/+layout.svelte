<slot />

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(html) {
    min-width: 320px;
    background: #f5f7f8;
    color: #182126;
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 16px;
    letter-spacing: 0;
  }

  :global(body) {
    min-height: 100vh;
    margin: 0;
  }

  :global(button),
  :global(input),
  :global(select) {
    font: inherit;
  }

  :global(code),
  :global(.mono) {
    font-family:
      "JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  }
</style>
