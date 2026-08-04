# Zotero Latex Math Tool — 工作交接笔记

本文件是跨会话恢复工作状态的依据，被自动加载。

## 项目是什么

Zotero 9 插件：PDF 阅读器工具栏加 Σ 按钮，点击后指定位置插入 LaTeX 公式。
公式以自由文本标注存储（协议：`[[math:display]] <latex>` / `[[math:inline]] <latex>`），
用 KaTeX 渲染成覆盖层（overlay），并隐藏页面上的原始 LaTeX 文本。双击渲染后的公式可编辑。
核心逻辑全在 `src/mathTool.ts`（`LatexMathTool` 类，约 2600 行）。
其他：`src/katexFonts.ts`（20 个 KaTeX 字体 data URL 内联）、`src/index.ts`/`addon.ts`/`hooks.ts`（模板生命周期）、`src/utils/*`。

## 沟通约定（用户偏好）

- **始终用中文回复。**
- 用户用 AI 开发、**不读代码**。给结论、风险和可操作建议，不要大段代码/文件 dump。
- 用户只想要一个简单小功能，**非常在意不要拖慢 Zotero**。一切改动以性能为最高优先级，但绝不牺牲已确认正常的功能。

## ⚠️ 红线（来自真实回归事故，勿再犯）

1. **渲染/隐藏链路四方法不得在无真机验证下改动**：
   `renderMathAnnotations`、`renderManagerOverlays`、`hideRawMathElements`、`getElementsWithMathText`。
   这四方法自提交 df1bcac 起未改动。曾因假设 DOM 结构（如 `data-annotation-id` == 标注 id、缩窄扫描根）
   导致"渲染公式 + 原始 `[[math:…]]` 文本同时显示"的回归。**真机确认 DOM 结构前，不做任何此类假设。**
2. 本环境（沙箱）**没有 Zotero**，无法跑 `npm run test`（需 Zotero 二进制，本地 `.env` 未填）。
   集成测试无法在此运行；运行时行为一律靠用户真机验证。

## 经验教训（勿再踩）

1. **Zotero 事件/DOM/state，真机验证前勿假设**。已确认的结构：工具栏与 PDF 页面在**同一文档**；
   Zotero 工具在 pointerdown/mousedown 就切换并抑制 click；`internalReader._state.tool` 才是工具状态真相源。
2. 防抖在连续事件流里会被反复重置。需要时按**信号类型**提速（本会话用 `pdfViewer.currentScale` 变化识别
   缩放 → rAF 一帧一次渲染）；不要全局缩短防抖。
3. **MutationObserver 回调在 paint 前执行**，可同步重隐藏新插入的原文节点，消除渲染闪烁。
4. 性能热路径的每次新增判断都要 **O(1) 短路**（如 `readerHasMath` 以 `_annotations.length` 作失效键），
   且只在确实有数学标注时才做事。
5. 状态切换用"**基线 + 连续 N 次偏离**"判定（tool monitor 用基线 `_state.tool` + 连续 2 次偏离），
   避免 Zotero 内部短暂重同步导致误杀。
6. **Zotero 自由文本标注的正文在 `comment` 字段，`text` 字段留空**。侧栏编辑只更新 `comment`；
   插件所有数学内容读取一律走 `getMathContent`（只读 `comment`），**不要用 `text ?? comment`**：
   `"" ?? comment` 遇空串返回空串，导致数学标注识别失败、渲染被短路（addAnnotation 建出的标注
   text 是空串）。创建/保存标注时只写 `comment`、不要写 `text`。
7. **Σ 新建走原生 `manager.addAnnotation`**（cbf9f79 起）：传最小入参（type/color/sortIndex/
   pageLabel/position/comment），Zotero 自动生成 id/日期/作者/tags、自行持久化、且会把 text
   填成空串。`position` 对 text 标注必需 `fontSize`/`rotation`（去掉直接报错）。`_save` 保留
   以保证立即落库（addAnnotation 自持久的时机不可控）。
8. **真机确认（2026-08）**：`manager._annotations` 是**数组**；`manager._unsavedAnnotations`
   是 **Map**（不是 Set 也不是数组，key 为 annotation 对象）。`_annotations` 读取统一走
   `getManagerAnnotations`（数组分支零开销、非数组退化为 `Array.from`）。pdf.js 自由文本
   控件把标注 id 存在 **`data-id`**（`data-annotation-id` 为空），原文在 textarea value 里。
9. **真机确认补充（2026-08）**：pdf.js 的 `pdfViewer._pageLabels` 真机上**不存在**，
   `getPageLabel` 实际走 `pageIndex+1` fallback（普通 PDF 页码正确；自定义页码 PDF 会显示错页码，
   低风险暂不处理，勿再依赖 `_pageLabels`）。Σ 工具栏定位：中文界面"新增文字"按钮命中
   `isFreeTextToolLabel` 正则，走 label 匹配路径、不依赖 fallback。`manager.setAnnotations`
   打开/编辑时从不被调用（补丁是无害死代码，保留）；`manager.updateAnnotations` 在编辑时确实
   触发（一次编辑计数 +1）。标注 `position.rects` 恒为单矩形。
10. **真机确认（2026-08）**：KaTeX 字体**只能 data URL 内联**。试过把字体改独立 woff2 文件、
    CSS 用 `chrome://mathtool/content/fonts/` 引用（与 favicon 同机制），真机验证**公式变系统
    默认字体**——PDF 页面加载不了 chrome:// 字体资源。data URL 是唯一验证可行的方式，勿再试
    外部字体 URL（Zotero 内置 KaTeX 字体同样不可跨文档引用）。

## 剩余可优化（详见 dev-notes/performance-optimization.md）

- **P2（已判不可行，永久关闭）**：KaTeX 字体 data URL 内联（bundle 约 1.1MB）。曾试改独立字体文件 +
  chrome:// 引用（bundle 可减 347KB），真机验证 PDF 页面加载失败、公式变系统字体，已回退。
  **用户明确要求：20 个 KaTeX 字体（含 `\mathfrak`/`\mathcal` 等特殊字体）全部保留、不可子集化**
  （用户文献常见这些字体，嫌字母不够用）。任何减小字体体积的方向（子集化/chrome:// 复用）都不做。
- **P3**：MutationObserver 触发面过大（characterData+attributes），风险高、放最后。
- **暂缓**：per-annotation 的 payload/position 缓存、`findPageElement` 按页取集合（标注数少时收益有限）。

**优化原则**：优先"增量/按需/复用"而非全量重扫；每次改动必须能解释清楚为什么不变慢；跑不动的部分先列出，不要盲改。

## 验证流程

- 改完必须过：`npm run build`（含 `tsc --noEmit`）、`npx eslint src/`、`npx prettier --check src/`。
- 运行时行为：让用户重新安装 `.scaffold/build/zotero-latex-math-tool.xpi` 真机验证。
- 需要真机 DOM 信息（无需 `npm run start`）：`npx zotero-plugin build --dev` 构建 dev 版
  （只产出 `addon/` 目录，不生成 xpi，需手动打包
  `(cd .scaffold/build/addon && zip -qr ../zotero-latex-math-tool.xpi .)`），装进 Zotero →
  帮助 > 调试日志 > 启用日志 → 查看输出日志，搜 `render diagnostics` 行复制 JSON。
  注意：production build 会把 `__env__` 编译为 `production`、诊断代码被短路；抓完用 `npm run build`
  恢复 production 再重装。
