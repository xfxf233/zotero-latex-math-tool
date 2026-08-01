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
| `renderManagerOverlays` 跳过无标注源文档          | 只渲染含标注原文控件的文档，隐藏重复视图不再白建 overlay（见 P1）                 |

> ✅ 以上四项改动均已实现、构建通过、**真机验证通过**，均已提交（a810086 + 后续提交）。

## 三、剩余可优化项（按优先级）

### ✅ 已做：`renderManagerOverlays` 跳过无标注源文档（基于真机结构）

- **真机确认**：即使只开一个 PDF，reader 内部也有隐藏的重复视图（实测 2× viewer.html +
  2× reader.html，`overlayCount=4`），同一标注被渲染 4 次；reader.html 无标注源文本却建 overlay
  （纯浪费）。
- 改动：对每个 doc，若 `getElementsWithMathText(doc)` 为空（该 doc 无标注原文控件），只清理该
  doc 上残留 overlay、跳过渲染。
- **真机验证结果**（dev 诊断实测）：`overlayCount` 4→2；reader.html 的 `managerOverlays` 1→0
  （残留框被清）；插入新公式场景同样为 2，插入时机正常（控件未生成的担忧未出现）。
- **未达 1 的原因**：2 个 viewer.html 都含标注原文控件（mathTextNodes=1），都被判为有效文档。
  若其中一个是隐藏副本，理论上可再砍到 1，但需先真机确认视图可见性（风险高，暂缓）。
- 风险：低-中。插入新公式瞬间 Zotero 控件可能尚未生成，overlay 会晚一点出现（observer + 750ms
  兜底自动补）；已真机验证插入时机正常。
- 剩余（未做）：per-annotation 的 payload/position 缓存、`findPageElement` 按页取集合。标注数少
  时收益有限，暂缓。

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
- 真机 DOM 结构（无需 `npm run start`）：`npx zotero-plugin build --dev` 构建 dev 版
  （只产出 `addon/` 目录，不生成 xpi；需手动打包
  `(cd .scaffold/build/addon && zip -qr ../zotero-latex-math-tool.xpi .)`），装进 Zotero 后：
  **帮助 > 调试日志 > 启用日志 → 查看输出日志**，搜 `render diagnostics` 行复制 JSON。
  注意：`npm run build`（production）会把 `__env__` 编译成 `production`，诊断代码被短路，
  所以必须用 dev 构建才能抓 DOM；抓完用 `npm run build` 恢复 production。
