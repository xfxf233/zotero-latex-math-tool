---
status: rejected
proposed: 2026-10
settled: 2026-10
---

# 编辑器支持任意取色

## 想法

编辑器的调色板只有 Zotero 内置颜色，用户可能想要自定义颜色。方案是用原生
`<input type="color">` 提供任意取色。

## 为什么不成立

`input[type=color]` 打开的是**系统**取色弹窗，不受页面布局控制。插件编辑器挂在 PDF
reader 的 iframe 里，弹窗会出现在与编辑器无关的位置（甚至另一个窗口），用户点完颜色
找不到对话框，交互不可接受。

## 后续约束

只提供 Zotero 内置调色板：`Zotero.Annotations.COLORS` 的 8 色 + 文本标注额外追加黑色，
顺序与阅读器右键菜单一致。选中色点会立即记忆到 pref；`annotation.color` 在保存时写入。

不改动的部分：只改正文时不碰颜色，避免把外部导入的非十六进制颜色覆盖成 hex。
