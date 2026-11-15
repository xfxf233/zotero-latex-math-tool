# 性能

设计目标：插件只做一件小事，不应拖慢 Zotero 本体。任何新增逻辑都按"稳态渲染零额外
开销、无数学标注的文档零开销"这条线衡量。

## 触发源

- 每个被观察文档上的 MutationObserver（`childList` + `subtree` + `characterData`，
  `attributeFilter` 只有 `style`），50ms 防抖。
- 窗口 `resize`、`pdfViewer.currentScale` 变化（后者由 observer 内检测，rAF 一帧一次
  同步 overlay 位置）。
- 翻页、缩放、编辑标注、拖动边框都会让 pdf.js 重建标注层，因此最终都会走一遍渲染。
- 插入、编辑、删除路径额外安排一次 750ms 的兜底渲染（同一句柄，连续调用合并）。

## 热路径

```
renderIfNeeded
├── 无数学标注、无残留 overlay、无待清理的隐藏残留 → 直接返回（O(1) 失效键：_annotations.length）
└── renderMathAnnotations
    ├── refreshObservedDocuments   // 只处理新出现的 page 文档
    ├── getMathAnnotations         // 取数学标注，构建 sources / ids
    ├── getElementsWithMathText    // 每个 page 文档一次 textarea/input 扫描
    ├── renderManagerOverlays      // O(标注数 × 文档数)，主开销
    │   └── 每标注：坐标换算 + 建/复用 overlay + fit（内容尺寸缓存命中时不读布局）
    ├── hideRawMathElements        // 复用上面的控件集合
    └── logRenderDiagnostics       // 仅 development 构建
```

## 缓存

| 缓存                      | 键 / 失效                                   | 作用                                                      |
| ------------------------- | ------------------------------------------- | --------------------------------------------------------- |
| `mathContentCache`        | `comment` 原文，上限 200                    | 跳过重复解析                                              |
| `katexHtmlCache`          | `(latex, display)`，上限 200                | 跳过重复 `renderToString`                                 |
| `mathControlCache`        | reader + 标注数量；数量变即失效             | 原文集合与 data-id 集合，避免 observer 热路径反复解析标注 |
| `formulaContentSizeCache` | fit-content span 元素（内容变化时整个替换） | 纯公式天然尺寸，稳态不读 `getBoundingClientRect`          |
| `richContentSizeCache`    | 内容元素 + 基准宽度 + 字号                  | 混排高度，稳态不读布局                                    |
| `mathAnnotationCache`     | `_annotations.length`                       | 记录 reader 是否有数学标注，用于短路                      |

尺寸类缓存只在 `document.fonts.status === "loaded"` 时读写，避免把未加载字体的错误
指标固化下来。所有 `WeakMap` 缓存在元素被丢弃后自动回收，不需要手动清理。

## 约束

总表见 [constraints.md](constraints.md)，这里只列与热路径直接相关的部分。

1. 无数学标注时每次 observer 回调只允许做 O(1) 判断。
2. 不得在回调里全量扫描文档；控件扫描每轮每文档最多一次，结果在渲染链路内复用。
3. 隐藏匹配以 `data-id` 优先，value 回退；不要退回到"解析所有标注再比字符串"。
4. KaTeX 字体必须 data URL 内联（PDF 页面加载不了 `chrome://`）。20 个字体全部保留，
   不做子集化——文献里的 `\mathfrak` / `\mathcal` 等需要完整字集。
5. 不要为每条标注建独立 observer 或独立样式表；overlay 复用同一个容器节点。
6. 改动热路径后，用 dev 构建观察 `render diagnostics` 的计数/规模变化；日志本身没有耗时
   字段，需要耗时就在代码里临时加 `performance.now()`，不要凭感觉。

## 已知取舍

- 暂不做 per-annotation 的 payload/position 缓存，也不做 `findPageElement` 的按页索引：
  标注数量少时收益低于维护成本。
- 标注文字、公式数量增长后，`renderManagerOverlays` 的 O(标注数 × 文档数) 是第一个
  需要再评估的点。
