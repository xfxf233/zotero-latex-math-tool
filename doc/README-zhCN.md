# Zotero LaTeX Math Tool

[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

[English](/README.md)

这是一个适用于 Zotero 9 的 LaTeX 数学公式插件。它会在 PDF 阅读器工具栏中添加数学公式按钮，并使用 KaTeX 将公式渲染到 PDF 注释层。

## 功能

- 在 Zotero 9 PDF 阅读器中添加 `Σ` 数学公式按钮。
- 在点击的 PDF 位置插入 LaTeX 公式。
- 使用 KaTeX 实时预览和渲染公式。
- 支持行间公式和行内公式。
- 支持修改注释颜色。
- 支持双击已渲染的公式进行编辑。
- 根据 Zotero 的界面语言自动显示中文或英文。

公式以 Zotero 自由文本注释保存，文本格式如下：

```text
[[math:display]] <latex>
[[math:inline]] <latex>
```

## 使用方法

1. 在 Zotero 中打开一个 PDF 附件。
2. 点击工具栏中的 `Σ` 按钮。
3. 点击 PDF 页面中需要插入公式的位置。
4. 输入不带 `$` 或 `$$` 的 LaTeX 内容。
5. 根据需要开启或关闭“大公式模式”。
6. 点击“插入”；以后可以双击公式进行编辑。

## 开发

```bash
npm install
npm run build
```

构建生成的 `.xpi` 位于 `.scaffold/build` 目录。

## 兼容性

插件清单当前支持 Zotero 9：

```json
"strict_min_version": "9.0",
"strict_max_version": "9.0.*"
```
