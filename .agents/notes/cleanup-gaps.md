---
status: proposed
proposed: 2026-11
---

# reader 生命周期缺口：shutdown 后仍在生效的残留

## 问题

`disposeRuntime`（[dispose.ts](../../src/math/dispose.ts)）是 reader 关闭、窗口关闭、插件卸载三条路径
唯一的清理点（[architecture.md](../../docs/architecture.md#L19-L32)）；
[constraints.md](../../docs/constraints.md#L41-L43) 要求注入样式、监听、observer、定时器都在这里释放。
以下缺口在拆分前就存在（`e564092^` 的单文件版本逐条核对过），重构只承诺行为不变；其中前两条已在
2026-11-15 真机确认后果。

1. **补丁在 shutdown 之后仍会执行（真机，最严重）。** `annotationManager` 的增改包装、`view` 的
   `adjustTextAnnotationPosition` 包装都没有卸载点（[patches.ts](../../src/math/patches.ts)），dispose
   只把 runtime 标记为已释放。真机现象：禁用插件后拖动原始文本框，插件仍进入测量路径并重新注入
   样式表，于是原文重新被隐藏、旧 overlay 在原位"复活"，且不再跟随文本框；拖动产生的 rect 还可能
   被包装改写。每次启用会再叠一层包装（推断），反复开关会累积无用的测量调用，旧闭包也让旧沙箱
   常驻内存。
2. **页面残留不清理（真机）。** dispose 不删 overlay 节点、不撤 `RAW_HIDDEN_CLASS`，只移除样式表。
   真机现象：禁用后 overlay 失去样式、塌到页面左上角压住正文；原文在标注框位置露出，但框是按渲染
   尺寸定的，长源码会被裁（只看到开头的 `$$`）。重开 PDF 才恢复。
3. **初始化没有取消语义。** `initializeReaderRuntime` 在三个 await 之后都不检查"插件是否已 shutdown、
   reader 是否已关闭"（[readerInit.ts](../../src/math/readerInit.ts#L42-L80)）；shutdown 只清
   `runtimeSet`，不取消 `ensureReaderPromises` 里的 in-flight 初始化
   （[mathTool.ts](../../src/mathTool.ts#L24-L31)）。两种触发场景后果不同：
   - **禁用/卸载时的 in-flight（推断）**：shutdown 之后晚到的初始化仍会登记 runtime、挂 observer、
     注入样式，并跑首轮渲染。插件已经停用，公式仍被渲染、原文仍被隐藏，直到 reader 关闭（晚装的
     `uninit` 包装届时会兜底清理）。
   - **初始化中关闭 reader**：`reader.uninit` 的包装是初始化最后一步才装的
     （[patches.ts](../../src/math/patches.ts#L371-L394)），关闭发生在之前时不会走 dispose。之后
     `waitForPDFWindow` 多半取不到窗口，最可能是空转 15 秒后抛 "PDF iframe window is not ready"、
     日志多一条错误，并让 `ensureReaderPromises`（普通 Map）暂时留住已关闭的 reader；是否还会登记
     孤儿 runtime 取决于 uninit 期间窗口何时失效，需真机确认（推断）。
4. **工具栏样式不移除。** `TOOLBAR_STYLE_ID` 由 `injectToolbarStyles` 注入工具栏文档
   （[insert.ts](../../src/math/insert.ts#L96-L102)），dispose 只按 `STYLE_ID` 删样式
   （[dispose.ts](../../src/math/dispose.ts#L65-L67)）。影响很小：只匹配 Σ 按钮的 class，按钮已删；
   同版本重新启用时 `injectToolbarStyles` 见 id 就早退，看不出差别。它主要违反上面那条约束。
5. **`renderTimer` 不复位。** dispose 只 `clearTimeout`，没像 `repeatTimer` / `syncRAF` 那样置
   `undefined`。纯一致性缺口，`runtime.disposed` 挡住重复清理，没有已知可观测问题。

## 方案

目标是让 shutdown 成为真正的终点：之后旧沙箱不能再对 reader 产生副作用；正常 reader 关闭仍走同一套
dispose。

1. 补丁失效：给 `state` 加 `alive`（shutdown 置 `false`），所有包装入口先判断，命中就直接调用原
   方法。不采用"恢复原方法"，避免覆盖其他可能的包装方；`reader.uninit` 包装保留，用于兜底清理晚到
   runtime。
2. 卸载时清页面：只在插件卸载路径删除本插件注入的 overlay 节点、撤 `RAW_HIDDEN_CLASS`、移除样式与
   按钮；不要放进每次 reader 关闭（文档本来就要销毁，白加一遍全文档扫描）。
3. 工具栏样式：dispose 的文档循环里顺带删 `TOOLBAR_STYLE_ID`；shutdown 再按 `Zotero.Reader._readers`
   补一遍，覆盖"样式已注入、runtime 还没建"的 reader。
4. `renderTimer`：`clearTimeout` 后置 `undefined`，与 `repeatTimer` / `syncRAF` 一致。
5. 晚到初始化：三个 await 之后检查 `state.alive` 与 reader 是否已关闭（提前装 uninit 标记或用
   `Components.utils.isDeadWrapper` 判断），取消时不登记 runtime、不挂 observer；shutdown 顺手清空
   `ensureReaderPromises`。
6. 落地时把本篇改名为 `reader-lifecycle-gaps`、状态转 `implemented`，正文按 implemented 模板改写成
   `问题 → 决策`。

## 风险

- 补丁短路动到正常路径（标注增改、拖动各多一次布尔判断；渲染热路径不受影响），要确认启用状态下
  行为与耗时不变。
- 不恢复原方法意味着多次开关后调用链上是多层直通包装，要确认没有累积的性能或行为影响。
- 卸载时删 overlay、撤隐藏会改页面内容，必须真机确认原文恢复、无重复文字；原文可能仍被 Zotero
  原框裁剪，这是框尺寸决定的，不在本次范围。
- 竞态的取消条件依赖 Zotero uninit 时机，必须真机确认。

## 验收

- 禁用插件、reader 仍开：无 overlay、页面无重复/错位文字、原文可见；工具栏无残留样式节点。
- 禁用后拖动原始文本框：走 Zotero 原生行为，插件不再测量、不再隐藏原文、不再改写 rect。
- 反复禁用/启用 5 次后再插入/拖动：行为正常、无可感知变慢、无重复 overlay。
- 初始化中禁用/关闭（dev 构建加可控延时复现）：不再出现新的渲染，`ensureReaderPromises` 不留条目。
- 没退出 PDF 直接重新启用插件：立即恢复渲染与 Σ 按钮。
- 正常打开/关闭/翻页/缩放/插入/编辑与现在一致（[testing.md](../../docs/testing.md#L63-L79) 的回归
  清单，重点第 1 条）。
