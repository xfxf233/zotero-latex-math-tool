---
status: implemented
proposed: 2026-11
settled: 2026-11
---

# 禁用插件后的残留：补丁、overlay 与样式

## 问题

`disposeRuntime` 是 reader 关闭、窗口关闭、插件卸载三条路径唯一的清理点
（[architecture.md](../../docs/architecture.md#L19-L32)），但它只处理 runtime 持有的 observer、
监听、定时器与样式表：既没有撤销挂在 Zotero 对象上的补丁，也不删插件注入页面的 overlay 与原文
隐藏状态。

2026-11-15 真机：渲染一条公式后禁用插件、reader 保持打开——

- Σ 按钮消失，overlay 失去样式、塌到页面左上角压住正文；原文在原标注框位置露出，但框是按渲染
  尺寸定的，长源码被裁（只看到开头的 `$$`）。
- 拖动原始文本框时插件仍被调用：测量路径重新注入样式表，原文再次被隐藏、旧 overlay 在原位
  "复活"，且不再跟随文本框；拖动产生的 rect 也可能被包装改写。
- 退出重进 PDF 恢复。

根因是 shutdown 之后旧沙箱的代码仍挂在 Zotero 的对象上、继续被回调。

## 决策

1. **补丁短路**：`state.alive` 在 shutdown 置 `false`；`annotationManager` 的增改包装与
   `view.adjustTextAnnotationPosition` 包装入口先判断，命中就直接调用原方法。不采用"恢复原
   方法"，避免覆盖其他可能的包装方；`reader.uninit` 包装保留，用于兜底清理晚到的 runtime。
2. **卸载时清页面**：只在插件卸载路径删除 overlay 容器、撤 `RAW_HIDDEN_CLASS`、移除残留的编辑器
   iframe；正常 reader 关闭不这样清（文档马上销毁，白加一遍全文档扫描）。
3. **工具栏样式**：dispose 的文档循环顺带删 `TOOLBAR_STYLE_ID`；shutdown 再按
   `Zotero.Reader._readers` 补一遍，覆盖"样式已注入、runtime 还没建"的 reader。
4. **定时器**：`renderTimer` clear 后置 `undefined`，与 `repeatTimer` / `syncRAF` 一致。
5. **样式注入兜底**：`injectStyles` 在 `state.alive` 为 `false` 时直接跳过，堵住旧闭包从拖拽、
   保存等路径再次注入样式表的可能。

禁用后原文被原框裁剪是接受的：用户拖一下框就会按源码重排，重开 PDF 也干净。

初始化晚到的路径不在本篇范围，见 [reader-init-race](reader-init-race.md)。

## 经验

- 补丁是 shutdown 之后旧代码还能执行的主要入口。只撤监听不够，包装函数必须有"插件还活着吗"的
  短路，否则禁用状态下 Zotero 的拖拽、外部更新仍会跑插件逻辑——真机上表现为渲染"复活"。
- 清理要分两类：挂在 Zotero/DOM 上的监听与样式，和插件自己注入的页面节点/class。后者不会随
  样式表删除而消失，反而因为失去定位塌到角落。
- 别为了"禁用后也好看"去动 Zotero 的标注重排：框尺寸由渲染结果决定，用户拖框或重开 PDF 就能
  恢复，代价不值得。
