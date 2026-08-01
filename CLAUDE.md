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

## 已完成工作（最近提交 7a0e286；df1bcac ~ 7a0e286 共 5 提交，未 push，main 领先 origin/main 5 提交）

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

### 性能优化（本会话 4 项，均真机验证通过，已提交）

- `renderIfNeeded` 短路：无标注且无残留 overlay 时跳过全量渲染（a810086）。
- `scheduleRender` repeat 3 次→1 次（250/750/1500 → 单次 750ms）（a810086）。
- `getElementsWithMathText` 去 TreeWalker：真机确认标注原文在
  `<textarea class="textAnnotation" data-id="<标注ID>">` 控件 value 里（标注 ID 在 `data-id`，
  `data-annotation-id` 为空），只扫 textarea/input、不再全文档扫描（a810086）。
- `renderManagerOverlays` 跳过无标注源文档：只渲染含标注原文控件的文档，隐藏重复视图不再白建
  overlay；dev 实测 `overlayCount` 4→2（7a0e286）。

## 性能优化路线图

详细分析见 `docs/performance-optimization.md`（含真机 DOM 结构、量化验证结果、dev 抓 DOM 方法）。

**已完成**（均真机验证通过）：见上文"性能优化"项。
**剩余按优先级**：

1. （可选）`renderManagerOverlays` 进一步 2→1：真机显示同一 PDF 有 2 个 viewer.html 都含标注源，
   若其中一个是隐藏副本可再砍到 1；但需先真机确认视图可见性，风险高、暂缓。
2. P2：KaTeX 字体 data URL 内联（bundle 约 1MB），改构建配置按需子集化。
3. P3：MutationObserver 触发面过大（characterData+attributes），风险高、放最后。
4. 暂缓：per-annotation 的 payload/position 缓存、`findPageElement` 按页取集合（标注数少时收益有限）。

**优化原则**：优先"增量/按需/复用"而非全量重扫；每次改动必须能解释清楚为什么不变慢；
跑不动的部分先列出，不要盲改。

## 验证流程

- 改完必须过：`npm run build`（含 `tsc --noEmit`）、`npx eslint src/`、`npx prettier --check src/`。
- 运行时行为：让用户重新安装 `.scaffold/build/zotero-latex-math-tool.xpi` 真机验证。
- 需要真机 DOM 信息（无需 `npm run start`）：`npx zotero-plugin build --dev` 构建 dev 版
  （只产出 `addon/` 目录，不生成 xpi，需手动打包
  `(cd .scaffold/build/addon && zip -qr ../zotero-latex-math-tool.xpi .)`），装进 Zotero →
  帮助 > 调试日志 > 启用日志 → 查看输出日志，搜 `render diagnostics` 行复制 JSON。
  注意：production build 会把 `__env__` 编译为 `production`、诊断代码被短路；抓完用 `npm run build`
  恢复 production 再重装。
