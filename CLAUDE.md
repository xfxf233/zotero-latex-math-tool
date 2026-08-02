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

## 当前状态（截至 2026-08-02）

- 最近提交 `a50a32c`（**未 push**，main 领先 origin/main 1）：清理冗余——合并重复的 toolbar 样式、
  去掉 Σ 按钮选中态的 box-shadow 粗线、删 `is-inline` 空开关。已真机验证正常。
- 此前所有性能优化与 bug 修复均已提交并真机验证，已同步到 origin/main。
- 剩余可优化项见下，均非急迫。

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

## 剩余可优化（详见 dev-notes/performance-optimization.md）

- **P2**：KaTeX 字体 data URL 内联（bundle 约 1.1MB），改构建配置按需子集化。
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
