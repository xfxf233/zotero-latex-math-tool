# 架构

Zotero 9–10.x 插件：在 PDF 阅读器工具栏加一个 Σ 按钮，把带 `mathtool` tag 或旧前缀的
自由文本标注渲染成 KaTeX overlay（文本 + `$...$` 行内公式 + `$$...$$` 块级公式），并隐藏
页面上的原始源码。双击渲染结果可再次编辑。

## 运行形态

- 插件跑在 Zotero 主进程的 bootstrap 沙箱：`addon/bootstrap.js` 调 `src/hooks.ts`。
- 插件单例挂在 `Zotero.MathTool`（`package.json` 的 `addonInstance`）。`LatexMathTool`
  只做生命周期接线；每个 reader 的 runtime（含 observer/定时器句柄）、渲染缓存与逐
  reader 标记登记在 `src/math/state.ts` 的 `state` 里（WeakMap/WeakSet/Map/Set），模块之间通过
  函数调用协作，不互相持有实例引用。
- 每个 PDF reader 有自己的 iframe 窗口（`reader._window`）。PDF 页面、标注层、工具栏
  **在同一个文档**里；overlay 就挂在这个文档上。
- 标注 rect 存的是 PDF 单位（pt，不随缩放变化）；overlay 容器按当前页 viewport 换算成
  CSS px 定位，内部内容按 PDF 单位排版后再 `transform: scale(zoom)` 跟随缩放。

## 启动与 reader 生命周期

1. `hooks.onStartup`：等 `initializationPromise` / `unlockPromise` / `uiReadyPromise` →
   `initLocale()` → `new LatexMathTool()` → `startup()`。
2. `startup()`（`src/mathTool.ts`）把 `ensureReader` 注入 `startToolbarIntegration`
   注册 `renderToolbar` 监听，并对启动时已打开的 PDF reader 补一次 `ensureReader`。
3. `renderToolbar` 事件 → `appendToolbarButton`（insert.ts：注入 Σ 并重定位）+
   `ensureReader`（readerInit.ts）。
4. `ensureReader` 幂等、并发去重（共享 in-flight Promise）。`initializeReaderRuntime`：
   等 `_waitForReader`、`primaryView.initializedPromise`、PDF 窗口就绪 → patch 标注管理器 →
   挂 `resize` → 登记 runtime → patch `reader.uninit` → 启动 observer → 首轮渲染。
5. 关闭：`disposeWindow`（按窗口，容忍死 wrapper）、`patchReaderUninit`（按 reader）、
   `shutdown`（插件卸载，清理全部 runtime）。所有 observer、监听、document 引用的清理
   都收敛在 `src/math/dispose.ts` 的 `disposeRuntime`。

## 模块

代码分三层：入口门面（`mathTool.ts`）、`src/math/` 下的 Zotero 集成模块、`src/richText/`
下的纯内容层。各模块职责：

| 路径                                     | 职责                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/mathTool.ts`                        | 插件门面 `LatexMathTool`：`startup` / `shutdown` / `disposeWindow`，只做接线。                      |
| `src/math/readerInit.ts`                 | `ensureReader`（幂等 + 并发去重）与 runtime 建立。                                                  |
| `src/math/dispose.ts`                    | 关闭 reader 时释放 runtime 的 observer、监听、定时器与注入样式。                                    |
| `src/math/insert.ts`                     | Σ 按钮注入/定位（含工具栏文档登记与取消监听）、数学插入模式、原生工具监视、点击接管与原生标注兜底。 |
| `src/math/patches.ts`                    | 包装 `annotationManager` 的增改入口、view 的 `adjustTextAnnotationPosition`、`reader.uninit`。      |
| `src/math/renderer.ts`                   | 渲染调度、MutationObserver、每轮渲染、选中/双击编辑入口。                                           |
| `src/math/overlay.ts`                    | 每条标注的 overlay DOM 与 fit 布局（纯公式 / rich）。                                               |
| `src/math/hiding.ts`                     | 隐藏/恢复页面上的原始数学源码控件。                                                                 |
| `src/math/annotations.ts`                | 标注创建/更新、补 `mathtool` tag、写 `pageLabel` 元数据。                                           |
| `src/math/annotationData.ts`             | 标注只读访问、解析缓存、`readerHasMath` 等 O(1) 判断。                                              |
| `src/math/editor.ts`                     | 公式编辑器弹窗与保存前测量。                                                                        |
| `src/math/measure.ts`                    | 内容尺寸测量与按测量结果写回 rect。                                                                 |
| `src/math/geometry.ts`                   | PDF/视口坐标换算、页码、缩放、点击位置。                                                            |
| `src/math/colors.ts`                     | 标注调色板与颜色偏好。                                                                              |
| `src/math/styles.ts` / `katex.ts`        | 样式注入（KaTeX 字体 data URL 内联）/ KaTeX 渲染与 HTML 缓存。                                      |
| `src/math/diagnostics.ts`                | dev-only 诊断日志。                                                                                 |
| `src/math/readerDocs.ts`                 | reader 文档/iframe 发现与 PDF 窗口等待。                                                            |
| `src/math/state.ts`                      | 插件级共享可变状态（runtime 注册表、缓存、逐 reader 标记、定时器句柄）。                            |
| `src/math/types.ts` / `constants.ts`     | 共享类型 / DOM 类名与排版常量。                                                                     |
| `src/math/util.ts` / `dom.ts` / `log.ts` | 纯工具 / DOM 增量写入 / 日志与错误提示。                                                            |
| `src/math/realm.ts` / `toolbarLabels.ts` | 跨 realm 克隆 / 原生工具按钮标签识别。                                                              |
| `src/richText/parse.ts`                  | 纯解析：tag/legacy 前缀识别、`$` 语法 → `RichDocument`。不依赖 Zotero / DOM / KaTeX。               |
| `src/richText/render.ts`                 | `RichDocument` → HTML 字符串；文本先转义，KaTeX 渲染函数由调用方注入。                              |
| `src/richText/layout.ts`                 | 纯内容层的布局判断：是否只有一个纯公式、legacy 内容迁移成 `$` / `$$` 语法。                         |
| `src/katexFonts.ts`                      | 20 个 KaTeX woff2 以 data URL 形式 import。                                                         |
| `src/styles.css`                         | overlay、编辑器、按钮的样式（打包进 bundle，运行时注入文档）。                                      |
| `src/addon.ts` / `hooks.ts` / `index.ts` | 插件实例、生命周期钩子、全局注册。                                                                  |
| `src/utils/`                             | 最小化的 `ztoolkit`（`getGlobal`）与 FTL 本地化初始化。                                             |
| `addon/`                                 | `manifest.json`、`bootstrap.js`、`locale/*/addon.ftl`、图标。                                       |
| `test/unit/richText.test.ts`             | 纯内容层单测（Node 内置类型剥离直接跑 `.ts`，不需要 Zotero）。                                      |

### 模块依赖

- `addon/bootstrap.js` 每次 `startup` 都重新 `loadSubScript` 整个 bundle，所以
  `src/math/state.ts` 的 `state` 生命周期是"一次插件启动"；挂在 Zotero 对象/DOM 上的
  监听与 observer 仍需在 shutdown 时显式清理。
- 依赖方向单向：入口/生命周期 → 补丁/渲染 → 数据/几何/编辑器/工具；底层模块不反向
  import `mathTool.ts`、`patches.ts`、`readerInit.ts`，避免 import 环。
- `insert.ts` 与 `readerInit.ts` 天然互需（插入后要确保 runtime，初始化又要 patch 标注
  管理器并回调捕获）。reader 初始化入口由 `startup` 通过
  `startToolbarIntegration(ensureReader)` 注入，两边不直接 import。
- 跨模块共享的可变状态只有 `src/math/state.ts` 的 `state`；模块之间不互相持有对方实例，
  逐 reader 的 runtime 通过参数传递并登记在 `state.runtimes`。原因与拆分过程见 [module-split](../.agents/notes/module-split.md)。

## 插入与编辑流程

Σ 按钮 → `activateNativeTextInsertMode`：把阅读器工具切到 `pointer`，装上捕获期
`pointerup` / `click` 监听（`installDirectPDFClickHandlers`），并用 `startToolMonitor`
监视工具状态（基线 + 连续 2 次偏离判定）；用户切走工具即取消本次插入。

用户点击页面后，插件在捕获期接管点击，用点击位置调 `openEditorInDocument`，保存时
`createAnnotationWithManager`。标注管理器补丁里的 `captureNativeTextAnnotation` 是兜底：
如果 Zotero 原生文本工具仍先建出了标注（例如工具状态竞态），就在 `addAnnotation` 返回时
`captureNativeTextAnnotation` → `completeNativeMathAnnotation` 打开编辑器，保存时走
`updateManagerAnnotation`。

保存路径：`normalizeEditorSource`（新建时解析不出公式就整段包成 `$$...$$`）→ 在编辑器
iframe 内测量内容尺寸 → 写 `position.rects` → 新建或更新标注（内容写 `comment`，tag 补
`{ name: "mathtool" }`，颜色和 rect 按需更新）→ 触发渲染。

单击已选中的 overlay（双击的第二下）→ `installRenderedFormulaDblClickHandler` 的 click
分支 → `openEditorInDocument`（编辑已有）→ `updateManagerAnnotationByID`。`dblclick`
只拦截原生编辑，不直接打开编辑器。

## 渲染链路

触发源是观察文档上的 MutationObserver、窗口 `resize` 和缩放变化；防抖、调用顺序、每步
开销与缓存见 [performance.md](performance.md#热路径)。

- overlay DOM：每页一个 `.zotero-latex-math-page-overlay` 容器，每条标注一个
  `.zotero-latex-math-manager-render`。
- 纯公式用 `.zotero-latex-math-fit-content`（贴合内容），文本+公式混排用
  `.zotero-latex-math-rich-content`（固定宽度换行）。
- 原文隐藏：给 textarea 加 `RAW_HIDDEN_CLASS`；匹配以 `data-id`（标注 id）优先，
  无 id 才回退 value 匹配。
- 坐标系换算：`getViewportRect` 把 PDF 单位 rect 换成当前页 viewport 的 CSS 像素。

细节（语法、几何、缓存）见 [rich-text.md](rich-text.md) 和 [performance.md](performance.md)。

## 对 Zotero 的补丁点

全部是包装/监听，不改 Zotero 源码。

| 位置                                                                              | 目的                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `annotationManager.addAnnotation` / `setAnnotations` / `updateAnnotations`        | 捕获新建的标注、在 partial 更新后重新判断是否需要渲染、清理残留隐藏。                                                                                                   |
| `annotationManager._save`（可选兼容）                                             | Zotero 10.x 不存在，包装不会触发；仅为旧版保留。                                                                                                                        |
| `_primaryView` / `_secondaryView` / `_lastView` 的 `adjustTextAnnotationPosition` | 拖动左右边框后按渲染内容返回 rect，并绕过 Zotero 对单行文本按源码回收宽度（上限 300pt）的规则。manager 持有的是调用时才读 view 方法的闭包，所以 patch view 生效。(源码) |
| `reader.uninit`                                                                   | reader 关闭时清理 runtime。                                                                                                                                             |
| `renderToolbar` 事件                                                              | 注入并重定位 Σ 按钮。                                                                                                                                                   |
| 阅读器文档上的捕获期 `dblclick`                                                   | 拦截原生编辑；打开编辑器由已选中标注的 click 分支负责。                                                                                                                 |
| PDF iframe 内捕获期 `click`                                                       | Σ 模式下的插入位置。                                                                                                                                                    |
