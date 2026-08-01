# 性能优化分析

> 目标：这个插件只做一件小事，不应拖慢 Zotero 本体。
> 本文记录渲染热路径的现状、已优化项、剩余可优化项与验证方式。
> 渲染链路四方法的行号基于提交 df1bcac（`git show df1bcac:src/mathTool.ts`）；
> 四方法本身未改动，调度层的 `renderIfNeeded` 短路见下文。

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
| `renderIfNeeded` 短路（调度层）                   | 无标注且无残留 overlay 时跳过全量扫描；有标注/有 overlay 时走原渲染路径          |
| `scheduleRender` repeat 3 次 → 1 次               | 插入/编辑后兜底渲染由 250/750/1500ms 减为单次 750ms，observer 兜底晚到内容       |
| `getElementsWithMathText` 去 TreeWalker           | 真机确认标注原文在 textarea/input 控件内，只扫控件、不再全文档扫描（见 P1）       |

> ⚠️ 以上三项改动已实现、构建通过，**待真机验证**（验证步骤见文末）。

## 三、剩余可优化项（按优先级）

### P1：`renderManagerOverlays` 的 O(标注×文档) 内层循环

- 位置：mathTool.ts:1069。每个文档、每个标注都重算 `getPDFPosition`（realm 克隆）、`parsePayload`（字符串 indexOf）、`findPageElement`（querySelector）、`getViewportRect`。
- 改进方向（低风险）：每标注的 payload/position 结果按 `annotation.id` 缓存（annotation 对象不变则可复用）；`findPageElement` 改为"按 pageIndex 一次取页面集合"而非每次 querySelector。
- 风险：中。缓存需在 annotation 更新时失效；不要引入对 DOM 属性的假设。
- **真机观测**（实测 1 标注）：`docCount=4`（2 个 `viewer.html` + 2 个 `reader.html`），
  `overlayCount=4`——同一标注在 4 个文档各渲染一次；其中 reader.html 上 `mathTextNodes=0`（无
  标注源文本）却仍创建 overlay。后续可考虑：跳过无标注源文本的 doc 的 overlay 渲染，但需先确认
  reader.html 的 `.page` 是可见 PDF 视图还是侧栏缩略图。

### ✅ 已做：`getElementsWithMathText` 去 TreeWalker（基于真机 DOM 结构）

- **真机确认的 DOM 结构**（`logRenderDiagnostics` 实测）：数学标注的原始文本控件是
  `<textarea class="textAnnotation" data-id="<annotationID>" …>`，`[[math:…]]` 文本存在
  `value` 里；标注 ID 在 `data-id` 属性上（`data-annotation-id`/`data-annotation-key` 均为空，
  印证不得按后者匹配标注）。
- 改动：只扫 `textarea,input` 控件的 `value`，不再对 viewer 做全文档 TreeWalker。
- 风险：低-中。所有 math 标注均由插件自身创建（`createAnnotationWithManager` 把 payload 写入
  text/comment），原文必然在控件 value 里；但需真机验证各种标注形态（display/inline、老标注、
  多页多标注）原文隐藏均正常。

### ✅ 已做：`scheduleRender(reader, true)` 兜底渲染 3 次 → 1 次

- 插入/编辑后由 250/750/1500ms 各渲染一次，改为单次 750ms（`renderIfNeeded`）。
- 依据：渲染幂等，多跑只是浪费 CPU；PDF.js 晚到的 DOM 更新会被 MutationObserver 兜底。
- 风险：低-中。极端慢速系统上原文（`[[math:...]]` 文本）隐藏可能晚约 0.7s 出现，需真机确认可接受。

### 新增：`renderIfNeeded` 短路（无标注场景）

- 位置：`scheduleRender` 的 50ms 主渲染与 750ms 兜底都改走 `renderIfNeeded`。
- 逻辑：`getMathAnnotations` 为空 **且** 所有 PDF 文档无 `.zotero-latex-math-manager-render` overlay 时直接 return，不跑 `renderMathAnnotations` 的全量扫描。
- 安全性：有标注或有残留 overlay 时仍走原渲染路径，清理已删除标注 overlay 的行为被 `hasAnyManagerOverlay` 保护，不会因短路而残留。
- 收益：无数学标注的 PDF（最常见场景）滚动/缩放/选择文本时不再做 iframe 树扫描 + 样式注入 + overlay 清理。

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
