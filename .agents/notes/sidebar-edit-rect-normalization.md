---
status: proposed
proposed: 2026-10
---

# 侧栏改 comment 后按宽度重算 rect

## 问题

在 Zotero 侧栏直接改数学标注的 `comment`（不经过插件弹窗）时，走的是 partial 更新：
Zotero 用原始源码文本（`$...$` 原文）估算高度，再调 `adjustTextAnnotationPosition`。
长混排因此会被缩成一个小框或者留下大片留白。现在靠 overlay 整体缩小兜底，内容能看，
但框和内容不匹配。

插件自己的编辑路径不受影响：它在调用 `updateAnnotations` 之前就改好了 manager 里的
标注对象，不会触发 Zotero 的重排。

目标：侧栏改完 comment 后，overlay 重渲染的同时按**当前 rect 宽度**重算高度并写回 rect。

## 方案

1. **渲染后测量再写 rect**：`updateAnnotations` 包装里识别 comment 变化 → 等 overlay
   重建完成 → 测量 rich 内容高度 → 写回 rect。时序最直接，但要确认写回 rect 不会再次
   触发 observer → 渲染的死循环（需要幂等判断）。
2. **接管 `adjustTextAnnotationPosition`**：用 manager 里最新的标注对象重新测量。问题是
   这个入口拿不到"新的 comment"，只能读到已经更新的标注对象——需要真机确认调用时序，
   否则拿到的是旧内容。

## 风险

- 与插件自身的保存路径重复计算；两条路径都要幂等。
- 拖动路径已经接管了同一个方法，改动要确保拖动行为不回退。
- 侧栏改完立刻关标签页时，异步测量可能跑在已销毁的文档上。

## 验收

- 侧栏把一条长混排标注改成更长的内容：框的高度跟着变，无缩小、无大片留白。
- 只改颜色、只改 tag 时不触发重排。
- 原生文本标注完全不受影响。
- 拖动左右/上下边框、插件弹窗编辑的行为与现在一致。
