---
status: proposed
proposed: 2026-11
---

# 两处 HEAD 遗留：未使用的 barrel 与 disposeRuntime 清理缺口

## 问题

以下问题在拆分前（HEAD 的单文件实现）就存在，本次重构只承诺"行为不变"，没有顺带修复，
留作独立任务。

1. **未使用的 barrel**：`src/richText/index.ts` 只有 `export * from "./parse"` /
   `"./render"` 两行，全仓库没有任何地方 import 它；拆分后新增的 `layout.ts` 也没有经过它。
2. **`disposeRuntime` 清理缺口**（`src/math/dispose.ts`）：
   - 注入的工具栏样式从未移除。dispose 只按 `STYLE_ID` 清阅读器文档；Σ 按钮样式由
     `injectToolbarStyles` 注入在工具栏文档（`insert.appendToolbarButton` 触发），
     插件禁用或 reader 关闭后仍留在该文档里。
   - `runtime.renderTimer` 只 `clearTimeout`，没有像 `repeatTimer` / `syncRAF` 那样置
     `undefined`。纯一致性缺口，`runtime.disposed` 挡住了重复清理，没有已知可观测问题。
   - **初始化与关闭的竞态**：`initializeReaderRuntime` 在 `_waitForReader` /
     `waitForPDFWindow` 等 await 之后没有"reader 是否已关闭 / 是否已 shutdown"的判断。
     初始化进行中关闭 reader 或禁用插件时，晚到的代码仍可能登记 runtime / 挂 observer；
     而 shutdown 的 `runtimeSet.clear()` 已经执行过，会留下孤儿 runtime 与 observer。
     dispose 也不会取消 `state.ensureReaderPromises` 里的 in-flight 初始化。

## 方案

1. 删除 `src/richText/index.ts`；以后需要统一入口时按需重建。
2. `disposeRuntime`：清理样式时一并移除 `TOOLBAR_STYLE_ID`，并把 `renderTimer` 置
   `undefined`。
3. 初始化竞态：给 `ensureReader` / `initializeReaderRuntime` 加取消语义——例如
   shutdown/dispose 时递增 generation 或给 reader 记"已 uninit"标志，await 之后发现状态
   已变则提前返回/抛错，不登记 runtime、不挂 observer。

## 风险

- 删除 barrel 的代价是以后新增纯层文件要显式 import；当前无引用，风险低。
- toolbar 样式移除要与 toolbar 重新渲染错开：`injectToolbarStyles` 会在下一次
  `renderToolbar` 重新注入，需要确认移除时机不会把刚注入的样式删掉。
- 竞态修复涉及生命周期时序，取消条件的判定（死 wrapper / uninit 标志 / generation）
  必须真机确认，改后要过 [testing.md](../../docs/testing.md) 的回归项
  1/3/8/11。

## 验收

- 插件禁用时阅读器窗口仍开着：工具栏文档里没有 `zotero-latex-math-toolbar-styles`
  残留；重新启用后 Σ 按钮样式正常。
- 初始化过程中关闭 reader 或禁用插件：不出现新的 observer 回调，`runtimeSet` 不残留，
  日志没有来自已销毁 reader 的渲染报错。
- 正常打开/关闭/翻页/缩放/插入/编辑行为与现在一致（[testing.md](../../docs/testing.md)）。
- `rg 'richText"' src test` 没有指向 barrel 的 import。
