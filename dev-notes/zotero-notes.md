# Zotero 运行时笔记（真机 + 源码确认）

> 这些是会直接影响插件正确性的 Zotero 内部行为。改数据层、渲染/隐藏链路前先读这里。
> 真机验证时间见各条标注；未标注的均为推断，动手前先确认。

## 1. 自由文本标注的数据

- 正文在 **`comment`** 字段，`text` 恒为空（`addAnnotation` 会把 text 填成空串）。
  - 所有数学内容读取走 `getMathContent`，只读 `comment`。
  - **不要用 `text ?? comment`**：`"" ?? comment` 返回空串，会导致识别失败、渲染被短路。
  - 创建/保存只写 `comment`，不写 `text`。
- `position.rects` 恒为**单矩形**。
- `PDFPosition` 的 `fontSize` / `rotation` 对 text 标注**必需**（去掉 `addAnnotation` 直接报错）。
- pdf.js 自由文本控件把标注 id 存在 **`data-id`**，`data-annotation-id` 为空；原文在 textarea 的 value 里。

## 2. 标注 tags（最容易踩）

- 阅读器内部标注 tag 是 **`{ name: "mathtool", color?: string }`**（数组）。
- 保存到 Zotero 条目时，`Zotero.Annotations.fromJSON` 用 `t.name` 生成条目 tag 的
  **`{ tag: "mathtool" }`**；读取时 `toJSON` 再把 `t.tag` 转回 `{ name }`。
- 因此：
  - 插件写 tag 必须写 **`{ name: "mathtool" }`**；
  - 写字符串或 `{ tag: "mathtool" }` 都会因为取不到 `name`，在保存时抛
    **`Tag data must contain 'tag' property`**（2026-10 真机 + Zotero 源码确认）。
  - 识别时三种形态都兼容（`hasMathTag`），但**写入只允许 `{ name }`**。
- 新增/编辑标注时用 `ensureMathTag` 统一归一化：string / `{ tag }` → `{ name }`，
  已有 `{ name }` 保留 color。

## 3. AnnotationManager

- 真机确认：`manager._annotations` 是**数组**；`manager._unsavedAnnotations` 是 **Map**
  （不是 Set、不是数组，key 为 annotation 对象）。读取统一走 `getManagerAnnotations`
  （数组分支零开销、非数组退化为 `Array.from`）。
- `addAnnotation`：传最小入参（type/color/sortIndex/pageLabel/position/comment），
  Zotero 自动生成 id/日期/作者/tags，并把 text 填成空串；`_save` 保留用于立即落库。
- `setAnnotations` 打开/编辑时从不被调用（补丁是无害死代码，保留）；
  `updateAnnotations` 在编辑时确实触发（一次编辑计数 +1）。
- **`updateAnnotations` 的入参可能是 partial**（例如侧栏只传 `{ id, comment }` 或
  `{ id, tags }`）；manager 合并后 `_annotations` 才是完整对象。插件的 update 补丁必须在
  `originalUpdateAnnotations` 之后按 id 取回完整标注，再做“是否数学标注/是否要渲染”的判断；
  直接对 partial 调 `parseAnnotationMath` 会因缺 `type`/`tags` 漏掉渲染（2026-10 修复）。
- `_save` 会把 annotation 交给 Zotero 保存层，`fromJSON` 的 tag 转换就在这条路径上；
  这是 tag 形状错误实际抛出的位置。

## 4. 工具栏 / 工具状态 / 事件

- 工具栏与 PDF 页面在**同一文档**。
- Zotero 工具在 pointerdown/mousedown 就切换并抑制 click；
  `internalReader._state.tool` 才是工具状态真相源。
- 状态切换用“**基线 + 连续 2 次偏离**”判定，避免 Zotero 内部短暂重同步导致误杀。
- 不要假设 `setTool` 会立刻同步 `_state.tool`；写入时以 `_state.tool` 为准。

## 5. 其他真机结论

- `pdfViewer._pageLabels` 真机不存在；`getPageLabel` 实际走 `pageIndex + 1` fallback。
  普通 PDF 页码正确；自定义页码 PDF 会显示错页码（低风险，暂不处理）。
- KaTeX 字体**只能 data URL 内联**。曾试独立 woff2 + `chrome://mathtool/content/fonts/`，
  PDF 页面加载不了 chrome:// 字体，公式变系统默认字体；已回退。20 个字体全部保留、
  不子集化（用户明确要求）。
- `MutationObserver` 回调在 paint 前执行，可同步重隐藏新插入的原文节点以消除闪烁。
- `attributeFilter` 只留 `style`（P3）：纯 class 变更不再触发 observer，写隐藏类不会自我触发渲染。
- 侧栏把数学标注改成普通文本会残留 `RAW_HIDDEN_CLASS`，会把普通文本染透明。
  修复：编辑路径 `hasStaleRawHiddenControls` → `staleRawHiddenReaders` → 补一次渲染清理。
- 标注页面/缩放变化由 pdf.js 重建标注层触发 observer；渲染链路要容忍 z-index、DOM 重建、
  重复视图（primary/secondary）和死 wrapper。

## 6. 标注颜色与偏好设置（Zotero 10.0.6 源码确认）

- 标注调色板是 **`Zotero.Annotations.COLORS`**，元素为 `[l10n key, hex]` 对
  （`general-yellow` → `#ffd400` 等 8 色）；Zotero 10 没有 `DEFAULT_COLORS`（旧版才可能
  存在，插件做了兼容回退）。
- 文本/墨迹标注在阅读器右键菜单里额外提供黑色：
  `EXTRA_INK_AND_TEXT_COLORS = [['general-black', '#000000']]`，排在 8 色之后。编辑器的
  9 色调色板与这个顺序一致。
- 标注颜色就是 `annotation.color`（十六进制字符串），`Zotero.Annotations.PROPS` 包含
  `color`；`updateAnnotations` / `_save` 会把它同步到条目的 annotationColor。
- `Zotero.Prefs.get(name, true)` / `set(name, value, true)` 的 `global=true` 表示 `name`
  是完整 pref 名（不再拼 `extensions.zotero.`）；`set` 对不存在的字符串 pref 会自动创建。
  插件的颜色记忆存在 `extensions.zotero.mathtool.lastAnnotationColor`。

## 7. 相关文档

- 混合文本/公式的识别、解析、几何、编辑器：[rich-text-spec.md](rich-text-spec.md)
- 渲染热路径与性能优化：[performance-optimization.md](performance-optimization.md)
- 文档索引与测试说明：[README.md](README.md)
