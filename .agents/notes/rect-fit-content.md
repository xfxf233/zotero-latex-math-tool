---
status: implemented
proposed: 2026-10
settled: 2026-10
---

# 纯公式 rect 按 fit-content 测量，拖动时接管 Zotero 重排

## 问题

纯公式的标注框比公式本身大：行高、`.katex-display` 的默认 margin、写死的 36pt 最小
宽度都会混进测量结果。混排又反过来被 36/20pt 的最小宽高撑成两行高。

## 决策

- 纯公式用临时 `fit-content` span 按 overlay 同款 CSS 测量，清掉块级公式的 1em 上下
  margin，不走 rich 容器的行高/块边距。框因此贴身。
- 混排的最小宽高只兜底一个当前字号，不写死数值。
- 编辑保存保留**当前 rect 宽度**，只重算高度，不再把用户拉宽的框改回 320pt。
- 拖动左右边框时遍历 patch `_primaryView` / `_secondaryView` / `_lastView` 的
  `adjustTextAnnotationPosition`：Zotero 在松手后调用它并用返回的 rect 继续，所以不会被
  后续重排覆盖。这里返回按渲染内容算出的 rect，同时绕过 Zotero 对"单行文本标注"按源码
  回收宽度（上限 300pt）的逻辑。
- 上下拖动宽度不变，原样返回，保留用户拖出的高度；四角拖动由 `updateAnnotations` 包装
  兜底。
- 带 `comment` 的更新（插件保存、侧栏改正文）不做上述重排。

## 经验

- 拖动时的测量在 reader 文档里做，坐标系是 CSS px。漏了 `layoutScale` 换算，150%/200%
  缩放下框会比内容高一截，截图上看不出来。换算规则见
  [constraints.md](../../docs/constraints.md) 的「几何」。
- 编辑器里的测量只能在编辑器 iframe 内做（先渲染预览 → 强制布局 → 等 `fonts.ready`）；
  在 reader 文档里量会读到未加载字体的指标。
- 已有标注的 rect 不会自动更新，拖动或编辑保存一次后才按新规则重算。这是有意为之：
  批量改写历史标注的 rect 风险高于收益。

现状见 [docs/rich-text.md](../../docs/rich-text.md) 的「rect 几何」。
