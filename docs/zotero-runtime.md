# Zotero 运行时事实

本插件直接依赖的 Zotero 内部行为。改数据层、隐藏/渲染链路、编辑器前先确认这里的结论
仍然成立。

**来源标注**：标 `(源码)` 的条目已对照 Zotero 10 的 `app/omni.ja` 复核；标 `(真机)` 的
来自真实 Zotero 观测，沙箱无法复现；标 `(推断)` 的只是由代码推得，动手前先验证。
未标注的读本仓库代码即可确认。线上仓库只用来读注释/结构，版本可能与安装版不同，
冲突时以 `omni.ja` 为准（见 [testing.md](testing.md#事实核实)）。

## 标注数据

- 自由文本标注的正文在 **`comment`**，`text` 恒为空。`(源码)`
  `AnnotationManager.addAnnotation` 会把 `text` / `comment` / `tags` / `pageLabel`
  补成空值，但 `color` 和 `sortIndex` 必填，缺了直接抛错。
- 读取一律走 `getMathContent`（只读 `comment`）。不要写 `text ?? comment`：`text` 是空串
  而不是 `undefined`，`??` 不会回退，识别会失败。
- `position.rects` 恒为单矩形；`position.fontSize` / `rotation` 对 text 标注必填。`(源码)`
  `updateAnnotations` 若带 `position` 而不带 `sortIndex` 会抛错。
- pdf.js 的自由文本控件把标注 id 放在 **`data-id`**，`data-annotation-id` 为空；
  原文在 textarea / input 的 value 里。`(真机)`

## 标注 tags

- 阅读器内部 tag 形态是 `{ name: "mathtool", color?: string }`。
- 保存到条目时 `Zotero.Annotations.saveFromJSON` 用 `t.name` 生成
  **`{ tag: "mathtool" }`** 传给 `item.setTags`；读取时 `toJSON` 再转换回 `{ name }`。`(源码)`
- 因此写入必须是 `{ name: "mathtool" }`。写字符串或 `{ tag: ... }` 时 `t.name` 是
  `undefined`，`Zotero.Tags.cleanData` 会抛
  `Tag data must contain 'tag' property`。`(源码)`
- 读取时三种形态都要兼容（旧标注来自不同版本的数据）。

## AnnotationManager

- `manager._annotations` 是数组；`manager._unsavedAnnotations` 是 **Map**（key 为
  annotation 对象）。`(源码)` 读取统一走 `getManagerAnnotations`。
- `addAnnotation` 只传最小入参（type/color/sortIndex/pageLabel/position/comment），
  Zotero 自动补 id、日期、作者，并要求 `color` / `sortIndex` 存在。`(源码)`
- `updateAnnotations` 的入参可能是 partial（侧栏只传 `{ id, comment }` 或
  `{ id, tags }`）：manager 会先把它和 `_annotations` 里的旧对象合并，再返回。`(源码)`
  插件的包装必须在原方法执行后按 id 取回**合并后**的完整标注，再判断类型和是否渲染。
- `setAnnotations` 是"外部变更"入口（reader 客户端侧改动会走到它），打开/编辑标注时
  未观察到调用。`(源码 + 真机)` 补丁仍保留，作为外部变更的兜底。
- 标注保存经 `_triggerSaving` 去抖后写库；`_save` 是插件包装的落库入口。`(源码)`
- `adjustTextAnnotationPosition` 由 manager 以闭包
  `(annotation, options) => view.adjustTextAnnotationPosition(...)` 持有——调用时才读
  view 上的方法。所以 patch `view.adjustTextAnnotationPosition` 能生效。`(源码)`

## 工具栏与工具状态

- 工具栏与 PDF 页面在同一文档里。`(真机)`
- 工具状态是 **对象** `{ type, color }`：`reader._state.tool`，`_updateState` 会把它同步给
  各个 view（`view.setTool`）。插件读的 `internalReader._state.tool.type` 就是这个对象。`(源码)`
- Zotero 工具在 pointerdown / mousedown 就切换并抑制 click，所以"点一下 Σ"不会误触
  PDF 点击。`(源码)`
- 工具切换存在短暂不同步（`setTool` 与 `_state.tool` 的写入顺序、多个 view 依次同步），
  插件因此用"基线 + 连续 2 次偏离"判定用户是否切走。`(真机)`
- pdf.js 内部有 `PDFViewer._pageLabels`，但在 Zotero 阅读器里取不到，`getPageLabel` 回退
  `pageIndex + 1`；自定义页码的 PDF 会显示错页码。`(源码 + 真机)`

## 页面、缩放与 DOM 重建

- 翻页、缩放会让 pdf.js 重建标注层，进而触发 MutationObserver；渲染链路必须容忍
  z-index 变化、DOM 重建、primary/secondary 双视图和失效的 wrapper。`(真机)`
- `MutationObserver` 回调在 paint 前执行，可以同步隐藏新插入的原文节点以消除闪烁。`(真机)`
- 侧栏把数学标注改成普通文本后会残留隐藏 class，必须由编辑路径补一次清理，
  否则原文被染成透明不可见。`(真机)`

## 颜色与偏好

- `Zotero.Annotations.COLORS` 是 `[l10n key, hex]` 对，8 色；另有
  `DEFAULT_COLOR`（单数，等于第一色）。文本/墨迹标注在右键菜单额外提供黑色
  `EXTRA_INK_AND_TEXT_COLORS = [['general-black', '#000000']]`。`(源码)`
- `Zotero.Annotations.PROPS` 含 `color`；`updateAnnotations` / `_save` 会把它同步到
  条目属性。`(源码)`
- `Zotero.Prefs.get(name, true)` / `set(name, value, true)` 的 `global=true` 表示
  `name` 是完整 pref 名；`set` 对不存在的字符串 pref 会自动创建。`(源码)`

## 资源加载

- PDF 页面加载不了 `chrome://` 资源，KaTeX 字体只能以 data URL 内联进样式表。`(真机)`
- 一个 PDF reader 窗口包含工具栏文档与多层 iframe；插件只把真正的 PDF 画布文档纳入观察，
  编辑器 iframe 必须排除。`(源码 + 真机)`
