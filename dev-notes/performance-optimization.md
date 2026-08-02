# 性能优化分析

> 目标：这个插件只做一件小事，不应拖慢 Zotero 本体。
> 本文记录渲染热路径的现状、已完成的优化（简述）与剩余可优化项。
> 渲染链路四方法（`renderMathAnnotations`/`renderManagerOverlays`/`hideRawMathElements`/
> `getElementsWithMathText`）自提交 df1bcac 起未改动，只优化了调度层。

## 一、渲染热路径（现状）

标注层任何 DOM 变化 → `MutationObserver`（观察 `doc.body`，childList+subtree+characterData+attributes，
50ms 防抖）→ `renderMathAnnotations` 全量渲染：

```
renderMathAnnotations
├── refreshObservedDocuments      // 增量，便宜
├── getPDFPageDocuments           // querySelector，便宜
├── renderManagerOverlays         // O(标注数 × 文档数)，主开销
│   └── 每标注: 坐标换算 + 建/复 overlay + fitFormulaToOverlay（getBoundingClientRect 强制布局）
├── hideRawMathElements           // 扫 textarea/input 控件
└── logRenderDiagnostics          // 已门控，development 才跑
```

触发：文本选中、翻页、缩放、tooltip、标注编辑都会触发（50ms 防抖后全量跑一遍）。

## 二、已完成（均真机验证通过、已提交）

- **无标注短路**：`renderIfNeeded` 双条件（无标注且无残留 overlay 即跳过）；`readerHasMath` 以
  `_annotations.length` 作失效键，O(1)。
- **`getElementsWithMathText` 只扫 textarea/input**：真机确认标注原文在控件 value 里，不再全文档扫描。
- **`renderManagerOverlays` 跳过无标注源文档**：隐藏重复视图不再白建 overlay（真机 overlayCount 4→2）。
- **`logRenderDiagnostics` 生产短路**；`getMathAnnotations` 纯化（渲染路径不再写 DB / 改 dateModified）。
- **`scheduleRender` 兜底 3 次→1 次**；缩放时用 rAF 一帧一次跟随（`scheduleOverlaySync`），
  observer 内检测 `pdfViewer.currentScale` 变化触发。

## 三、剩余可优化项（按优先级）

1. **P2：KaTeX 字体 data URL 内联**：20 个 woff2（约 400KB base64）内联进 bundle
   （`mathtool.js` 约 1.1MB），并注入每个被观察文档 + 每次打开的编辑器 iframe。
   改进方向：按需子集化 / 仅注入一次并复用 / 改用 chrome:// 资源引用。
   改构建配置 `zotero-plugin.config.ts` 的 `loader: { ".woff2": "dataurl" }`。风险中。
2. **P3：MutationObserver 触发面过大**：`characterData` + `attributes` 使文本选择、tooltip 等都触发渲染。
   改进方向：收紧 `attributeFilter`、跳过纯 class 变更；或对"非标注层变更"只做防抖不做全量。
   风险高（怕漏掉真实需要重渲染的变更），放最后。
3. **暂缓**：per-annotation 的 payload/position 缓存、`findPageElement` 按页取集合（标注数少时收益有限）。

## 四、验证方式

- 性能是否变好：打开一个**多页、多公式、文本稠密**的 PDF，观察滚动/缩放/选择文本时的卡顿；
  或对比 dev 模式下 Zotero 调试日志里 `render diagnostics` 行的耗时。
- 回归是否引入：改完先 `npm run build` + eslint/prettier，再让用户重装 xpi 真机验证插入、编辑、
  双击编辑、关标签页。
- 真机 DOM 结构（无需 `npm run start`）：`npx zotero-plugin build --dev` 构建 dev 版
  （只产出 `addon/` 目录，不生成 xpi；需手动打包
  `(cd .scaffold/build/addon && zip -qr ../zotero-latex-math-tool.xpi .)`），装进 Zotero 后：
  **帮助 > 调试日志 > 启用日志 → 查看输出日志**，搜 `render diagnostics` 行复制 JSON。
  注意：`npm run build`（production）会把 `__env__` 编译成 `production`，诊断代码被短路，
  所以必须用 dev 构建才能抓 DOM；抓完用 `npm run build` 恢复 production。
