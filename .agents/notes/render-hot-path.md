---
status: implemented
proposed: 2026-08
settled: 2026-10
---

# 渲染热路径：短路、单次扫描、缓存与 observer 收窄

## 问题

渲染由 MutationObserver 全量触发（翻页、缩放、编辑都会重建标注层）。最初每轮都扫描
文档、解析所有标注、读布局，导致滚动和选中文本都卡。

## 决策

1. **无标注短路**：`renderIfNeeded` 在无数学标注、无残留 overlay、无待清理的隐藏残留时
   直接返回；`readerHasMath` 以 `_annotations.length` 作 O(1) 失效键。
2. **只扫 textarea/input**：原文在控件的 value 里，不需要全文档扫描。每轮每文档扫一次，
   结果同时供 overlay 渲染和原文隐藏复用。
3. **跳过没有标注源的文档**：重复视图不再白建 overlay。
4. **observer 收窄**：`attributeFilter` 只留 `style`。纯 class 变更（选中、hover、tooltip）
   不再触发；写隐藏 class 也不会自我触发一次防抖全量渲染。`style` 必须保留——缩放和
   拖动靠它重定位。
5. **隐藏匹配以 `data-id` 优先**：value 只作无 id 时的回退，且标注原文集合按标注数量
   缓存，回调里不再解析标注。
6. **尺寸缓存**：纯公式的天然尺寸按 span 元素缓存，混排高度按"内容元素 + 宽度 + 字号"
   缓存，稳态渲染不读 `getBoundingClientRect`。只在 `document.fonts` 就绪后读写。
7. **诊断代码 production 短路**，不靠运行时判断。

## 经验

- 第 4 条意味着**仅改 class 不会触发重渲染**。以后若要按 class 同步状态，必须显式
  调用渲染，不能指望 observer。
- 所有缓存的失效都依赖"元素被替换"或"数量变化"。若将来改为原地更新元素内容，
  缓存会静默过期，需要在更新处显式失效。
- 标注数量很大时，`renderManagerOverlays` 的 O(标注数 × 文档数) 仍是主开销，
  这是下一个要评估的点。

现状与约束见 [docs/performance.md](../../docs/performance.md)。
