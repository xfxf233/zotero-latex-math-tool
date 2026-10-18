# Zotero LaTeX Math Tool

[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

[中文说明](doc/README-zhCN.md)

A Zotero plugin that adds a LaTeX math insertion tool to the PDF reader
toolbar. Free-text annotations may mix plain text with `$...$` inline math and
`$$...$$` display math; the plugin renders the whole annotation on the PDF
overlay with KaTeX. Annotations created by the plugin carry a `mathtool` tag;
native Zotero text annotations are never modified.

![demo](doc/demo.png)

## Usage

1. Open a PDF attachment in Zotero.
2. Click the `Σ` toolbar button.
3. Click a position on the PDF page.
4. Type text directly. Wrap inline math in `$...$` and block equations in
   `$$...$$`. Use `\$` for a literal dollar sign. If the whole input contains
   no math, it is inserted as a block equation.
5. Click `Insert` / `Save`.
6. Double-click a rendered annotation to edit it later.

Old `[[math:display]]` / `[[math:inline]]` annotations are still supported and
are migrated to the new syntax when edited. The source is stored as plain
annotation text (the `comment` field), so it syncs with Zotero normally; a
device without the plugin will show the raw source.

## Development

```bash
npm install
npm run build
npm run test:rich-text   # pure parser/renderer tests, no Zotero required
```

The build command runs `zotero-plugin build` and `tsc --noEmit`. The packaged
`.xpi` is emitted by `zotero-plugin-scaffold` under `.scaffold/build`.

`npm test` runs the Zotero integration tests (`test/integration/`) and requires
a Zotero binary plus a local `.env`. See [dev-notes/README.md](dev-notes/README.md)
for the test layout and development documentation.

## Zotero Compatibility

The add-on manifest targets Zotero 9 and later:

```json
"strict_min_version": "9.0",
"strict_max_version": "10.*"
```

Zotero 7 and 8 may also work but are not tested. To try, change the
`strict_min_version` field in `addon/manifest.json` and re-package the `.xpi`.

## Acknowledgements

- [Zotero Community](https://www.zotero.org/)
- [Linux.do](https://linux.do/)
