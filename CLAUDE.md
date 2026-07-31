# Zotero Latex Math Tool — 工作交接笔记

本文件是跨会话恢复工作状态的依据。被自动加载，无需手动读取。

## 项目是什么

Zotero 9 插件：在 PDF 阅读器工具栏加 Σ 按钮，点击后指定位置插入 LaTeX 公式。
公式以自由文本标注存储（协议：`[[math:display]] <latex>` / `[[math:inline]] <latex>`），
用 KaTeX 渲染成覆盖层（overlay），并隐藏页面上的原始 LaTeX 文本。双击渲染后的公式可编辑。

核心逻辑全在 `src/mathTool.ts`（`LatexMathTool` 类，约 2260 行）。
其他：`src/katexFonts.ts`（20 个 KaTeX 字体 data URL 内联）、`src/index.ts`/`addon.ts`/`hooks.ts`（模板生命周期）、`src/utils/*`。

## 沟通约定（用户偏好）

- **始终用中文回复。**
- 用户用 AI 开发，**不读代码**。给结论、风险和可操作建议，不要大段代码/文件 dump。
- 用户只想要一个简单小功能，**非常在意不要拖慢 Zotero**。一切改动以性能为最高优先级，但绝不牺牲已确认正常的功能。

## ⚠️ 红线（来自真实回归事故，勿再犯）

1. **不得在无真机验证下改动渲染/隐藏链路**：
   `renderMathAnnotations`、`renderManagerOverlays`、`hideRawMathElements`、`getElementsWithMathText`
   这四个方法必须与提交 df1bcac 保持一致，除非用户先在真机确认。
   - 事故：曾假设 DOM 上 `data-annotation-id` == 标注对象 `id`，据此在 `hideRawMathElements` 里做
     按标注匹配 → 实际属性不匹配，导致"渲染公式 + 原始 `[[math:display]]` 文本同时显示"的回归。
     结论：**真机确认 DOM 结构前，不要做任何按标注 ID 的隐藏判定**。
   - 也曾把 `getElementsWithMathText` 扫描根缩窄到 `.annotationLayer` 等 → 同样回归。已还原。
2. 本环境（沙箱）**没有 Zotero**，无法跑 `npm run test`（需 Zotero 二进制，本地 `.env` 未填）。
   集成测试无法在此运行；运行时行为一律靠用户真机验证。

## 已完成工作（提交 df1bcac，未 push，main 领先 origin/main 1 提交）

- P0 内存泄漏：`patchReaderUninit` 包装 `reader.uninit()`，关 PDF 标签页时释放 runtime；
  `disposeRuntime` 幂等、对已销毁窗口安全（Zotero 的 `ReaderTab.close()`/`Reader.notify` 都走 `uninit()`）。
- P0 性能：`logRenderDiagnostics` 按 `__env__ === "development"` 门控，生产不再每次渲染全量扫 DOM。
- P0 可靠性：`getMathAnnotations` 改为纯函数；`pageLabel` 回填移到 `ensureAnnotationMetadata`，
  只在 ensureReader/updateAnnotations/setAnnotations 触发，不再在渲染路径写 DB。
- P1：`appendToolbarButton` 幂等（防重复 Σ 按钮）。
- 死代码清理：`element.ondblclick`（overlay 有 `pointer-events:none`，永不触发）、模板遗留 `MyToolkit` 类。
- ESLint：重新启用 `@typescript-eslint/no-unused-vars`。
- CI：`ci.yml` 删除 test job（scaffold 会自动下载 Zotero beta 无头跑，无意义且可能因版本不匹配变红）。
  现只保留 lint + build。

## 性能优化路线图

详细分析见 `docs/performance-optimization.md`。主战场按优先级：

1. `renderManagerOverlays` 内层循环的 O(标注数 × 文档数) 全量开销（每渲染都跑）。
2. `getElementsWithMathText` 全文档 TreeWalker，每次渲染扫整个 viewer 的文本节点。
3. `scheduleRender(reader, true)` 的 3 次兜底渲染（250/750/1500ms）。
4. KaTeX 20 个字体 data URL 内联（bundle 约 1MB）+ 每个文档注入含 data URL 的样式表。

**优化原则**：优先"增量/按需/复用"而非全量重扫；每次改动必须能解释清楚为什么不变慢；
跑不动的部分先列出，不要盲改。

## 验证流程

- 改完必须过：`npm run build`（含 `tsc --noEmit`）、`npx eslint src/`、`npx prettier --check src/`。
- 运行时行为：让用户重新安装 `.scaffold/build/zotero-latex-math-tool.xpi` 真机验证。
- 需要真机 DOM 信息：让用户 `npm run start` 开发模式，从 Zotero 调试日志取 `logRenderDiagnostics`
  （仅 development 下输出）的真实结构，再据此改动。
