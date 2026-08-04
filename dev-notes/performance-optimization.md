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
│   └── 每标注: 坐标换算 + 建/复 overlay + fitFormulaToOverlay（内容尺寸已缓存，
│       稳态渲染无 getBoundingClientRect 强制布局）
├── hideRawMathElements           // 扫 textarea/input 控件
└── logRenderDiagnostics          // 已门控，development 才跑
```

触发：翻页、缩放、标注编辑、style 变更（标注坐标/尺寸）都会触发（50ms 防抖后全量跑一遍）。
文本选中、tooltip、hover 等纯 class 变更不再触发（P3 起 attributeFilter 只留 style）。

## 二、已完成（均真机验证通过、已提交）

- **无标注短路**：`renderIfNeeded` 双条件（无标注且无残留 overlay 即跳过）；`readerHasMath` 以
  `_annotations.length` 作失效键，O(1)。
- **`getElementsWithMathText` 只扫 textarea/input**：真机确认标注原文在控件 value 里，不再全文档扫描。
- **`renderManagerOverlays` 跳过无标注源文档**：隐藏重复视图不再白建 overlay（真机 overlayCount 4→2）。
- **`logRenderDiagnostics` 生产短路**；`getMathAnnotations` 纯化（渲染路径不再写 DB / 改 dateModified）。
- **`scheduleRender` 兜底 3 次→1 次**；缩放时用 rAF 一帧一次跟随（`scheduleOverlaySync`），
  observer 内检测 `pdfViewer.currentScale` 变化触发。
- **fit-content 内容尺寸缓存**（`measureFitContent`）：按 span 元素 WeakMap 缓存 KaTeX
  内容天然尺寸，稳态重定位渲染跳过 `getBoundingClientRect` 强制布局。span 随 LaTeX 变化
  整体替换 → 条目自然失效；`document.fonts` 未 loaded 时不读缓存，避免字体指标固化错误。
- **`_annotations` 非数组防御**（`getManagerAnnotations`）：统一读取标注列表，数组分支
  零开销原引用返回；非数组退化为 `Array.from` 不抛错。真机确认（2026-08）：
  `_annotations` 是数组、`_unsavedAnnotations` 是 **Map** —— 内部容器不保证是数组。
- **P3：MutationObserver 观察面收紧**（`createMutationObserverOptions`，2026-08 真机验证通过）：
  `attributeFilter` 只留 `style`，去掉 `class` 与 5 个 `data-*`，`childList`/`characterData`
  保留。纯 class 变更（文本选择/tooltip/hover）不再触发 observer；写 `RAW_HIDDEN_CLASS`
  不再自我触发一次防抖全量渲染（旧行为：缩放时每隐藏一个 textarea 都多排一次全量渲染）。
  `style` 保留保证缩放/拖动照常重定位 overlay。真机验证缩放/翻页/插入/编辑/文本选择无回归。

## 三、剩余可优化项（按优先级）

1. **P2（已判不可行，勿再试）：KaTeX 字体 data URL 内联**：20 个 woff2（约 400KB base64）内联进
   bundle（`mathtool.js` 约 1.1MB），并注入每个被观察文档 + 每次打开的编辑器 iframe。
   **2026-08 真机验证**：曾实现"独立 woff2 文件 + CSS `chrome://mathtool/content/fonts/` 引用"
   （bundle 减至 751KB、字体进 xpi），但 PDF 页面**加载不了 chrome:// 字体**，公式全部变系统默认
   字体。已回退 data URL 方案。data URL 是唯一验证可行的字体携带方式，不再尝试外部字体 URL。
   用户明确要求 **20 个字体全部保留、不可子集化**（文献常见 `\mathfrak`/`\mathcal` 等），
   P2 永久关闭，不再做任何减小字体体积的尝试。
2. **暂缓**：per-annotation 的 payload/position 缓存、`findPageElement` 按页取集合（标注数少时收益有限）。

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
