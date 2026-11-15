---
status: proposed
proposed: 2026-11
---

# reader 初始化晚到的竞态

## 问题

`initializeReaderRuntime` 在 `_waitForReader` / `initializedPromise` / `waitForPDFWindow` 三个
await 之后都不检查"插件是否已 shutdown、reader 是否已关闭"
（[readerInit.ts](../../src/math/readerInit.ts#L42-L80)）；`shutdown` 只清 `runtimeSet`，不取消
`state.ensureReaderPromises` 里的 in-flight 初始化（[mathTool.ts](../../src/mathTool.ts#L28-L40)）。
两种场景后果不同：

- **禁用/卸载时的 in-flight（推断）**：`state.alive` 只让 Zotero 回调上的包装短路，初始化本身仍
  会走完：登记 runtime、挂 observer、注入样式，并跑首轮渲染。插件已经停用，公式仍被渲染、原文
  仍被隐藏，直到 reader 关闭（晚装的 `uninit` 包装届时兜底清理）。
- **初始化中关闭 reader**：`reader.uninit` 的包装是初始化最后一步才装的
  （[patches.ts](../../src/math/patches.ts#L386-L410)），关闭发生在之前时不会走 dispose。之后
  `waitForPDFWindow` 多半取不到窗口，最可能是空转 15 秒后抛 "PDF iframe window is not ready"、
  日志多一条错误，并让 `ensureReaderPromises` 暂时留住已关闭的 reader；是否还会登记孤儿 runtime
  取决于 uninit 期间窗口何时失效，需真机确认（推断）。

## 方案

1. 给 reader 记"已关闭"标记：把 `patchReaderUninit` 提前到第一个 await 之前装（它的 uninit
   回调在没有 runtime 时只做标记），或在每个 await 之后用 `Components.utils.isDeadWrapper` /
   `_internalReader` 判断。
2. 三个 await 之后各检查一次 `state.alive` 与"已关闭"；命中就提前结束，不登记 runtime、不挂
   observer、不注入样式。
3. shutdown 清空 `state.ensureReaderPromises`。
4. 取消不能表现成"初始化失败"：调用方目前对 `ensureReader` 一律 `.catch(logError)`，关闭 reader
   的常规路径不该刷一条错误。要么抛可识别的取消错误并在调用方跳过日志，要么返回 `undefined` 并
   让需要 runtime 的调用方跳过后续渲染。
5. 复现要靠 dev 构建在 await 后加可控延时（例如 2s），否则手工抢不到窗口。

## 风险

- 取消条件依赖 Zotero uninit 的时机与死 wrapper 判定，必须真机确认。
- 改的是初始化返回约定或错误处理，会波及 insert 侧的 `ensureReaderReady` 调用点，需要逐个确认
  不会吞掉真实错误。
- dev 延时只进 dev 构建，不能带进 production 包。

## 验收

- 初始化中禁用插件（dev 延时复现）：禁用后不再新增 overlay，日志没有旧沙箱的渲染记录。
- 初始化中关闭 reader（同样用延时）：不再空转 15 秒后报 "PDF iframe window is not ready"，
  `ensureReaderPromises` 不留条目。
- 正常打开/关闭/翻页/缩放/插入/编辑与现在一致（[testing.md](../../docs/testing.md#人工回归清单)，
  重点第 1 条），并过新增的禁用/启用回归项。
