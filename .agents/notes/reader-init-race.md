---
status: implemented
proposed: 2026-11
settled: 2026-11
---

# reader 初始化晚到的竞态

## 问题

`initializeReaderRuntime` 原本在 `_waitForReader`、`primaryView.initializedPromise`、
`waitForPDFWindow` 三个 await 之后都不检查"插件是否已 shutdown、reader 是否已关闭"，
`shutdown` 也不清 in-flight；`reader.uninit` 的包装要到初始化末尾才装。由此有三种后果：

- **禁用/卸载时 in-flight**：初始化会走完并登记 runtime、挂 observer、跑首轮渲染。但
  `injectStyles` 被 `state.alive` 挡住，页面没有插件样式——overlay 以未排版形式插进页面、
  `RAW_HIDDEN_CLASS` 没有对应 CSS，原文不隐藏；`removePageResidue` 已在 shutdown 跑过，
  残留持续到 reader 关闭。
- **初始化中关闭 reader**：Zotero 的 `initializedPromise` 只在 PDF 文档初始化完成时 resolve
  （安装版 10.0.8 `resource/reader/reader.js:75407、75698`），文档没加载完就关可能永不 settle
  ——初始化 promise 永久 pending、没有日志，`ensureReaderPromises`（强引用 Map）永久留住已
  关闭的 reader（源码推断）。关在 `waitForPDFWindow` 时死 wrapper 会直接抛 NS_ERROR
  （`ReaderInstance.uninit()` 不清 `_iframeWindow`，`xpcom/reader.js:706-732`）；关在
  `_waitForReader` 时 10 秒后抛 `Waiting for reader failed`（同文件 1583-1596）。
- startup 对已打开 reader 的 `void ensureReader(...)` 没有 catch，上述 reject 会变成未处理
  rejection。

## 决策

1. **关闭信号**：`patchReaderUninit` 提前到第一个 await 之前装；uninit 时把 reader 记进
   `state.closedReaders` 并调用 `state.readerInitAborts` 里登记的取消函数，没有 runtime 时
   只做这两件事。包装装得比关闭晚的情况用
   `Components.utils.isDeadWrapper(reader._iframeWindow)` 兜底。
2. **取消**：每个 in-flight 初始化登记一个取消函数，每个 await 与取消信号 race（取消时
   resolve，不 reject，免得没人再等时变成未处理 rejection）；入口与每个 await 之后都检查
   `state.alive`、关闭标记与死 wrapper，命中抛 `ReaderInitCancelled`，不登记 runtime、不碰
   页面。`waitForPDFWindow` 的轮询接受中止谓词，`getPDFWindow` 整体 try/catch（关闭中的死
   wrapper 只算"这一轮没找到"）。
3. **取消不写日志**：调用方统一用 `logReaderInitError`（`readerInitCancel.ts`）过滤取消错误，
   startup 那处也补上了 catch。
4. **shutdown**：先 `alive = false`，再取消全部 in-flight、清空 `readerInitAborts` 与
   `ensureReaderPromises`（释放对已关闭 reader 的强引用），最后照旧清 runtime 与页面残留。

## 考虑过但没选的

- 取消时返回 `ReaderRuntime | undefined`：要改 `ReaderInitializer` 类型和四处
  `.then(runtime => scheduleRender(...))`，波及比"可识别错误 + 日志 helper"大。
- 在 overlay / hiding 热路径加 `state.alive` 判断：会把"禁用后仍渲染"变成静默发生，还给热
  路径多加一次判断；在初始化处中止更干净。

## 经验

- 关 reader 真正的风险不是"多跑一次初始化"，而是 Zotero 的 promise 可能永不 settle。只查
  状态不 race，会漏掉最常见的挂起形态。
- 关闭信号有两个来源（uninit 包装、shutdown）；Zotero 的 `uninit()` 不清 `_iframeWindow`，
  所以死 wrapper 检查必须单独留着，不能只靠自己的标记。
- 自动化只覆盖编译与纯逻辑；禁用时正在初始化、打开大 PDF 立刻关这两条只能在真机验证。
