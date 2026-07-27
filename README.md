# Zotero LaTeX Math Tool

A Zotero 9 plugin that adds a LaTeX math insertion tool to the PDF reader
toolbar. Equations are stored as Zotero free-text annotations with a small text
protocol and rendered back onto the PDF overlay with KaTeX.

## Features

- Adds a `Σ` toolbar button to Zotero 9 PDF reader tabs.
- Opens a dedicated LaTeX editor on the clicked PDF location.
- Renders live previews with KaTeX.
- Stores only plain LaTeX text in Zotero annotations:
  - `[[math:display]] <latex>`
  - `[[math:inline]] <latex>`
- Watches annotation layers with `MutationObserver` and replaces matching text
  annotations with KaTeX HTML/MathML output.
- Supports double-click editing of rendered equations.
- Cleans up toolbar listeners, DOM observers, and modal state on reader/plugin
  shutdown.

## Development

```bash
npm install
npm run build
```

The build command runs `zotero-plugin build` and `tsc --noEmit`. The packaged
`.xpi` is emitted by `zotero-plugin-scaffold` under `.scaffold/build`.

For a live development session:

```bash
npm run start
```

## Zotero Compatibility

The add-on manifest targets Zotero 9:

```json
"strict_min_version": "9.0",
"strict_max_version": "9.0.*"
```

## Usage

1. Open a PDF attachment in Zotero.
2. Click the `Σ` toolbar button.
3. Click a position on the PDF page.
4. Enter plain LaTeX without `$` or `$$`.
5. Keep `Display Mode` checked for larger block equations, or uncheck it for
   inline math.
6. Click `插入` / `保存`.
7. Double-click a rendered formula to edit it later.
