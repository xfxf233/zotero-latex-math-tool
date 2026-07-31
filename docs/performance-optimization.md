# 性能优化分析

> 目标：这个插件只做一件小事，不应拖慢 Zotero 本体。
> 本文记录渲染热路径的现状、已优化项、剩余可优化项与验证方式。
> 所有行号基于提交 df1bcac（`git show df1bcac:src/mathTool.ts`）。

## 一、渲染热路径（现状）

标注层任何 DOM 变化 → `MutationObserver`（观察 `doc.body`，childList+subtree+characterData+attributes，50ms 防抖）→
`renderMathAnnotations(runtime)` → 全量渲染：

```
renderMathAnnotations (mathTool.ts:773)
├── refreshObservedDocuments      // 增量，便宜
├── getPDFPageDocuments           // querySelector，便宜
├── renderManagerOverlays         // O(标注数 × 文档数)，主开销
│   └── 每标注: getPDFPosition + parsePayload + findPageElement
│            + getViewportRect + getPageOverlay + renderManagerOverlayElement
│            + fitFormulaToOverlay（getBoundingClientRect → 强制布局）
├── hideRawMathElements           // O(整个 viewer 文本节点)，主开销
│   └── getElementsWithMathText   // 全文档 TreeWalker + 每文本节点 parsePayload
└── logRenderDiagnostics          // 已门控，development 才跑
```

触发频率：任何文本选中、翻页、缩放、tooltip、标注编辑都会触发（50ms 防抖后全量跑一遍）。

## 二、已完成的优化（提交 df1bcac）

| 项                                                | 效果                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| `logRenderDiagnostics` 按 `__env__` 门控          | 生产环境不再每次渲染做 2 次全量 TreeWalker + JSON.stringify                     |
| `getMathAnnotations` 纯化                         | 渲染路径不再写 DB / 改 `dateModified`，消除首渲染的 `scheduleRender(true)` 风暴 |
| `scheduleRender` repeat 仍是 3 次（250/750/1500） | 曾减为 1 次，因担心影响回归被还原；后续可谨慎重试                               |

## 三、剩余可优化项（按优先级）

### P1：`renderManagerOverlays` 的 O(标注×文档) 内层循环

- 位置：mathTool.ts:1069。每个文档、每个标注都重算 `getPDFPosition`（realm 克隆）、`parsePayload`（字符串 indexOf）、`findPageElement`（querySelector）、`getViewportRect`。
- 改进方向（低风险）：每标注的 payload/position 结果按 `annotation.id` 缓存（annotation 对象不变则可复用）；`findPageElement` 改为"按 pageIndex 一次取页面集合"而非每次 querySelector。
- 风险：中。缓存需在 annotation 更新时失效；不要引入对 DOM 属性的假设。

### P1：`getElementsWithMathText` 全文档扫描

- 位置：mathTool.ts:961。每次渲染对每个 page 文档走一遍 TreeWalker，逐文本节点 `parsePayload`。
- 改进方向：标注文本位置是确定的（Zotero 的 free-text 控件），但**上次尝试缩窄扫描根导致回归**——真机确认 DOM 结构前不要动扫描范围。低风险替代：把"结果按 doc 缓存 + 标注变更才失效"做增量，而不是每次全扫。
- 风险：中。必须先真机确认标注文本控件的真实 DOM 位置。

### P2：`scheduleRender(reader, true)` 的 3 次兜底渲染

- 位置：mathTool.ts:669。插入/编辑后 250/750/1500ms 各全量渲染一次。
- 改进方向：可减为 1 次（如 750ms）。上次减为 1 次时恰逢回归事故，被整体还原；需单独评估，且与"原文本隐藏"无因果（observer 已兜底晚到内容）。
- 风险：低-中。渲染幂等，多跑只是浪费 CPU。

### P2：KaTeX 字体 data URL 内联

- 20 个 woff2（约 296KB）base64 后（约 400KB）内联进 bundle（`mathtool.js` 约 1.08MB），并注入每个被观察文档 + 每次打开的编辑器 iframe。
- 改进方向：按需子集化 / 仅注入一次并复用 / 改用 chrome:// 资源引用。改构建配置 `zotero-plugin.config.ts` 的 `loader: { ".woff2": "dataurl" }`。
- 风险：中（涉及构建产物与字体路径）。

### P3：MutationObserver 触发面过大

- `characterData: true` + `attributes`（含 class/style）使文本选择、tooltip 等都触发渲染。
- 改进方向：收紧 attributeFilter、跳过纯 class 变更；或对"非标注层变更"只做防抖不做全量。
- 风险：高（怕漏掉真实需要重渲染的变更）。放在最后。

## 四、验证方式

- 性能是否变好：让用户打开一个**多页、多公式、文本稠密**的 PDF，观察滚动/缩放/选择文本时的卡顿；或对比优化前后 Zotero 调试日志里 `render diagnostics`（development 模式）的耗时。
- 回归是否引入：改完先 `npm run build` + eslint/prettier，再让用户重装 xpi 真机验证插入、编辑、双击编辑、关标签页。
- 真机 DOM 结构：`npm run start` 开发模式，Zotero 调试日志看 `logRenderDiagnostics` 输出。
