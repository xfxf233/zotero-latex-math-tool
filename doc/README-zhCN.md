# Zotero LaTeX Math Tool

[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

[English](/README.md)

这是一个适用于 Zotero 的公式/文本插件。它会在 PDF 阅读器工具栏中添加公式按钮，并使用 KaTeX 把自由文本标注渲染到 PDF 注释层。标注里可以混写普通文本和 `$...$` 行内公式、`$$...$$` 块级公式。插件创建的标注带有 `mathtool` tag；Zotero 原生文本标注不会被修改。

![演示效果](demo.png)

## 使用方法

1. 在 Zotero 中打开一个 PDF 附件。
2. 点击工具栏中的 `Σ` 按钮。
3. 点击 PDF 页面中需要插入内容的位置。
4. 直接输入文本；行内公式用 `$...$`，块级公式用 `$$...$$`，字面量美元符号用 `\$`。如果整段内容没有任何公式，会按块级公式插入。
5. 保存前可以选择 Zotero 自带的标注颜色（黄、红、绿、蓝、紫、品红、橙、灰、黑）；插件会记住最后一次选择的颜色，之后插入新公式默认使用它。
6. 点击“插入”/“保存”。
7. 以后双击渲染后的标注可再次编辑。

旧的 `[[math:display]]` / `[[math:inline]]` 标注仍然可用，编辑保存时会迁移成新语法。源码存放在标注的 `comment` 字段里，按 Zotero 原生方式同步；没装插件的设备会看到原始源码。

## 开发

```bash
npm install
npm run build
npm run test:rich-text   # 纯解析/渲染单测，不需要 Zotero
```

构建生成的 `.xpi` 位于 `.scaffold/build` 目录。`npm test` 是 Zotero 集成测试
（`test/integration/`），需要 Zotero 二进制和本地 `.env`。测试目录结构与开发文档见
[dev-notes/README.md](../dev-notes/README.md)。

## 兼容性

插件当前支持 Zotero 9 及以上：

```json
"strict_min_version": "9.0",
"strict_max_version": "10.*"
```

zotero 7 和 8 可能也能用，但没有经过测试。若想尝试，可以修改 addon/manifest.json 中 strict_min_version 字段，然后重新打包生成 xpi 文件。

## 感谢

- [Zotero 社区](https://www.zotero.org/)
- [L站](https://linux.do/)
