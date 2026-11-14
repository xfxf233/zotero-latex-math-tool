---
status: implemented
proposed: 2026-10
settled: 2026-10
---

# 纯公式 rect 按 fit-content 测量，拖动时接管 Zotero 重排

## 要解决的问题

纯公式的标注框比公式本身大：行高、`.katex-display` 的默认 margin、写死的 36pt 最小
宽度都会混进测量结果。混排又反过来被 36/20pt 的最小宽高撑成两行高。

## 决策

- 纯公式按 overlay 里 `fit-content` 的实际 DOM 测量，清掉块级公式的 1em 上下 margin，
  不走 rich 容器的行高/块边距。框因此贴身。
- 混排的最小宽高只兜底一个当前字号，不写死数值。
- 编辑保存保留**当前 rect 宽度**，只重算高度，不再把用户拉宽的框改回 320pt。
- 拖动左右边框时直接 patch `_primaryView.adjustTextAnnotationPosition`：Zotero 在松手后
  调用它并用返回的 rect 继续，所以不会被后续重排覆盖。这里返回按渲染内容算出的 rect，
  同时绕过 Zotero 对"单行文本标注"按源码回收宽度（上限 300pt）的逻辑。
- 上下拖动宽度不变，原样返回，保留用户拖出的高度；四角拖动由 `updateAnnotations` 包装
  兜底。
- 带 `comment` 的更新（插件保存、侧栏改正文）不做上述重排。

## 最容易出错的地方

拖动时的测量发生在 reader 文档里，那里的坐标系是 CSS px。必须用当前页 viewport scale
换算：CSS px = PDF 单位 × scale，量完高度再除回去。漏了这步在 150%/200% 缩放下换行数
变多、高度永远收不拢——现象是"拖动后框比内容高一截"，很难从截图看出来。

另一条：编辑器里的测量必须在编辑器 iframe 内完成（先渲染预览 → 强制布局 → 等
`fonts.ready`）。在 reader 文档里量会读到未加载字体的指标。

## 影响

已有标注的 rect 不会自动更新，拖动或编辑保存一次后才按新规则重算。这是有意为之：
批量改写历史标注的 rect 风险高于收益。

现状见 [docs/rich-text.md](../../../docs/rich-text.md) 的「rect 几何」。
