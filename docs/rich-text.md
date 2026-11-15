# 标注内容：语法、渲染与几何

一条 Zotero 自由文本标注里可以混写普通文本和 `$...$` / `$$...$$` 公式，插件把整条标注
渲染成一个 overlay。只做数学，不做完整 Markdown。

## 识别

一条标注是数学标注，当且仅当：

1. `annotation.type === "text"`；且
2. `annotation.tags` 含 `mathtool`，或 `comment` 含旧前缀 `[[math:display]]` /
   `[[math:inline]]`。

只有数学标注进入隐藏原文 / overlay / 双击编辑链路。普通 text 标注完全不参与。

tag 读取兼容 `{ name }` / `{ tag }` / 字符串三种形态和单对象形态；**写入只允许**
`{ name: "mathtool" }`（阅读器内部格式，Zotero 保存时 `saveFromJSON` 会转成条目 tag，
读回时 `toJSON` 再转回 `{ name }`）。

## 语法

### 行内公式

```
设 $x$ 为变量，则 $x^2 \ge 0$。
```

- `$` 包裹，同一行内闭合；不跨行。
- 开 `$` 后不能紧跟空白，闭 `$` 前不能是空白，闭 `$` 后不能紧跟数字（Pandoc 规则，
  用来排除 `$5 and $10` 这类金额）。

### 块级公式

```
设 $x$ 为变量，则

$$x^2 \ge 0$$

恒成立。
```

- `$$` 包裹，可跨行；渲染为独立块并居中。
- `$$` 前后切断文本：公式前、公式后各成一段。
- `$$` 内可以出现单个 `$`，只有未转义的 `$$` 才闭合。

### 转义与边界

- 文本里的 `\$` 是字面美元符；`\\` 是字面反斜杠。
- 公式内的 `\$` 不作为闭合符，原样交给 KaTeX。
- 未闭合的 `$` / `$$`、空公式（`$$$$`、`$ $`）按普通文本处理，不吞内容。
- 旧前缀优先识别，新写入不再产生前缀。
- `\(...\)`、`\[...\]`、`\begin{equation}` 不支持。`\displaystyle` 只影响数学样式，
  不是块级开关；块级必须用 `$$`。

## 文档模型

`src/richText/parse.ts` 产出顺序节点列表：

- `text`：原文（含换行，渲染时 `white-space: pre-wrap`）；
- `inline-math`：行内 latex；
- `display-math`：块级 latex。

`mathCount` 是公式节点数，为 0 时不算数学标注。首尾空白在解析前去掉；只含空白、且
紧邻块级公式的文本节点在解析阶段丢弃。

## 渲染

- 一条标注一个 overlay 元素，挂在该页的 page overlay 容器下。
- **纯公式**（只有公式节点、没有普通文本，含 legacy 标注）走 `fit-content` +
  `fitFormulaToOverlay`：框贴合公式，超宽时整体等比缩小。
- **文本 + 公式混排**走 rich 布局：文本段是块级容器，行内公式是其中的 inline span，
  块级公式单独成块居中。
- 文本节点先 HTML 转义再插入；KaTeX 输出直接插入（`trust: false`）。
- KaTeX 失败不抛错（`throwOnError: false`），渲染成红色错误文本。
- 混排字号取 `annotation.position.fontSize`（缺省 14），行高 1.4，颜色取
  `annotation.color`；纯公式走 fit-content，靠整体缩放贴合 rect。
- 内容变化才重建 `innerHTML`；稳态渲染只更新坐标和缩放。

## 编辑器

- 一个输入框 + 实时预览（输入防抖约 100ms）。
- 新建：内容能解析出公式就按混合文本保存；解析不出公式则整段包成 `$$...$$`。
- 编辑已有标注：按原样保存。删掉所有公式就变成普通文本——`mathtool` tag 不主动移除，
  只是不再渲染。
- 旧前缀标注打开时显示成 `$$...$$` / `$...$`，保存时迁移；取消不改。
- 保存前 `trim()`，空内容禁止保存。
- 预览与最终 overlay 共用同一套 CSS；颜色见下节。

## 颜色

编辑器只提供 Zotero 内置标注调色板：运行时读 `Zotero.Annotations.COLORS`
（`[l10n key, hex]` 对，8 色），末尾追加黑色（与 Zotero 的
`EXTRA_INK_AND_TEXT_COLORS` 一致），共 9 色，顺序与阅读器右键菜单一致。旧版 Zotero
回退 `DEFAULT_COLORS`，再兜底 8 色。
编辑已有标注时，只有用户点色点才写 `annotation.color` 并记到 pref
`lastAnnotationColor`；新建标注会写入编辑器当前色。只改正文不碰颜色（避免覆盖外部
导入的非十六进制颜色）。

## rect 几何

- 新建：先按点击位置放一个 220×48 的 viewport px 默认 rect（100% 缩放时即 220×48pt），
  保存时再按内容测量覆盖。
- 测量在编辑器 iframe 里做（渲染预览 → 强制布局 → 等 `fonts.ready`），用与 overlay
  相同的 CSS 量出 PDF 单位宽高，再按当前页 viewport scale 写回 `position.rects`。
- 纯公式按 `fit-content` DOM 测量（清掉 `.katex-display` 的默认 margin），宽度上限
  720pt，超宽时宽高等比缩小，框贴身。
- 混排按内容的自然宽度排版；含普通文本时宽度上限 320pt（`RICH_TEXT_MAX_WIDTH`），
  只有公式时 720pt。最小宽高取 `ceil(fontSize)`，与原生文本标注的最小尺寸一致。
- 编辑已有标注按它**当前的 rect 宽度**重排（clamp 到 720pt），只重算高度，不再把
  用户手动拉宽的框改回默认值。
- 拖动左右边框：接管阅读器各 view 的 `adjustTextAnnotationPosition`
  （`_primaryView` / `_secondaryView` / `_lastView`），按新宽度 + 渲染内容返回 rect。
  拖动上下边框宽度不变，保留用户拖出的高度。四角拖动由 `updateAnnotations` 包装兜底。
- 在 reader 文档里测量必须传 `layoutScale`，换算规则见 [constraints.md](constraints.md)
  的「几何」。漏了这步在 150% / 200% 缩放下换行数会变多、高度收不拢。
- 渲染时 rich 内容在 PDF 单位下排版（宽度 = rect 宽 / zoom），再整体
  `transform: scale(zoom)`；纯公式按 fit 缩放；缩放都不重排。

## 范围外

标题、列表、加粗/斜体、链接、图片、表格、代码块；公式编号、交叉引用；原生文本标注的
自动渲染；改变 Zotero 原生文本工具的行为；`\(...\)` / `\[...\]`。
