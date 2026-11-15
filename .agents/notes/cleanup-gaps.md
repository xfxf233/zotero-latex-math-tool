---
status: proposed
proposed: 2026-11
---

# disposeRuntime 的清理缺口与初始化竞态

## 问题

`disposeRuntime`（[dispose.ts](../../src/math/dispose.ts)）是 reader 关闭、窗口关闭、插件卸载三条路径
唯一的清理点（[architecture.md](../../docs/architecture.md#L19-L32)）；
[constraints.md](../../docs/constraints.md#L41-L43) 要求注入样式、监听、observer、定时器都在这里释放。
以下缺口在拆分前就存在（`e564092^` 的单文件版本逐条核对过），重构只承诺行为不变，没有顺带修。

1. **工具栏样式没有移除。** `TOOLBAR_STYLE_ID` 由 `injectToolbarStyles` 注入工具栏文档
   （[insert.ts](../../src/math/insert.ts#L96-L102)，`renderToolbar` 时触发），dispose 只按 `STYLE_ID`
   删样式（[dispose.ts](../../src/math/dispose.ts#L65-L67)）。插件禁用、reader 仍开着时，这个 style
   节点留在 reader 文档里（工具栏与 PDF 页面同文档，[architecture.md](../../docs/architecture.md#L14-L15)）。
   影响很小：只匹配 Σ 按钮的 class，按钮已删；reader 关闭时文档一起销毁；同版本重新启用时
   `injectToolbarStyles` 见 id 就早退，看不出差别。它主要违反上面那条约束，并让"改工具栏 CSS 后禁用
   再启用"的开发流程继续用旧样式。

2. **`renderTimer` 没有复位。** dispose 只 `clearTimeout`，没像 `repeatTimer` / `syncRAF` 那样置
   `undefined`。纯一致性缺口，`runtime.disposed` 挡住重复清理，没有已知可观测问题。

3. **初始化没有取消语义（唯一有用户可见后果的一项）。** `initializeReaderRuntime` 在三个 await 之后
   都不检查"插件是否已 shutdown、reader 是否已关闭"（[readerInit.ts](../../src/math/readerInit.ts#L42-L80)）。
   shutdown 只清 `runtimeSet`，不取消 `ensureReaderPromises` 里的 in-flight 初始化
   （[mathTool.ts](../../src/mathTool.ts#L24-L31)）。两种触发场景后果不同：

   - **禁用/卸载时的 in-flight（推断）**：shutdown 之后晚到的初始化仍会登记 runtime、挂 observer、
     注入样式，并在 50ms 后跑首轮渲染。插件已经停用，公式仍被渲染、原文仍被隐藏，直到 reader 关闭
     （晚装的 `uninit` 包装届时会兜底清理）。这是用户能看到的。
   - **初始化中关闭 reader**：`reader.uninit` 的包装是初始化最后一步才装的
     （[patches.ts](../../src/math/patches.ts#L371-L394)），关闭发生在之前时不会走 dispose。之后
     `waitForPDFWindow` 多半取不到窗口，最可能是空转 15 秒后抛 "PDF iframe window is not ready"、
     日志多一条错误，并让 `ensureReaderPromises`（普通 Map）暂时留住已关闭的 reader；是否还会登记
     孤儿 runtime 取决于 uninit 期间窗口何时失效，需真机确认（推断）。

4. **候选：overlay DOM 与原文隐藏状态也不在清理范围（推断，待真机确认）。** dispose 不删
   `.zotero-latex-math-manager-render` / `.zotero-latex-math-page-overlay`，也不撤 `RAW_HIDDEN_CLASS`；
   插件禁用时样式表没了、overlay 元素还在，页面里可能出现重复或错位的渲染文本。真机确认后再决定
   并入本篇还是一篇单列。

## 方案

1. 工具栏样式：在 dispose 现有的文档循环里一并删 `TOOLBAR_STYLE_ID`；shutdown 再多走一遍
   `Zotero.Reader._readers`，对仍打开的 reader 取 `state.readerDocs` 里的文档删一次，覆盖"样式已注入、
   runtime 还没建"的 reader（这类没有 runtime 可走）。不新建可枚举的文档强引用集合。
2. `renderTimer`：`clearTimeout` 后置 `undefined`，与 `repeatTimer` / `syncRAF` 一致。
3. 初始化竞态：插件级加 `state.alive`（shutdown 置 `false`，模块状态随下次 startup 重建），三个 await
   之后各检查一次；同时检查 reader 是否已关闭——不能只靠 `uninit` 包装设的标志（它装得太晚），要么
   把包装提前到第一个 await 之前，要么用 `Components.utils.isDeadWrapper` / `_internalReader` 判断。
   取消时直接返回/抛错，不登记 runtime、不挂 observer。shutdown 顺手清空 `ensureReaderPromises`。
4. 若第 4 条真机成立：在 `shutdown` 里按 runtime 文档删 overlay 节点、撤 `RAW_HIDDEN_CLASS`。不要放进
   `disposeRuntime`：正常 reader 关闭时文档随即销毁，清不清等价，放进去只会给每次关闭多加一遍全文档
   查询。

## 风险

- 样式删除范围：要确认工具栏文档不被多个 reader 共享（当前每个 reader 自己一个文档，依据见
  architecture.md 的运行形态）；共享时删一次会影响其他 reader。
- shutdown 先 `stopToolbarIntegration`，正常路径不会再注入；`disposeWindow`（主窗口关闭）与 reader
  关闭并发的时序仍需真机确认。
- 竞态修复动生命周期顺序，取消条件依赖 uninit 安装时机与死 wrapper 判定，必须真机验证；改后过回归项 1
  和新增的生命周期检查（见下）。
- 第 4 条改的是页面内容，移除 overlay 后原文必须恢复可见，只做真机确认过的部分。

## 验收

- 禁用插件、reader 仍开：reader 文档里没有 `zotero-latex-math-toolbar-styles` 节点（dev 控制台或诊断
  日志确认）；页面没有重复渲染文本、原文可见（第 4 条成立时）；重新启用并重开 PDF 后 Σ 与样式正常。
- in-flight 时禁用插件（dev 构建在 `_waitForReader` 后加可控延时复现）：禁用后不再新增 overlay，日志
  没有来自旧沙箱的渲染记录。
- in-flight 时关闭 reader（同样用延时复现）：不再空转 15 秒后报 "PDF iframe window is not ready"，
  `ensureReaderPromises` 不留条目。
- 正常打开/关闭/翻页/缩放/插入/编辑行为与现在一致（[testing.md](../../docs/testing.md#L63-L79) 的回归
  清单，重点第 1 条）。
