# 混合文本 + 公式渲染规格与实现状态（feat/rich-text-math）

> 目标：一条 Zotero 自由文本标注里可以同时写普通文本和 `$...$` / `$$...$$` 公式，
> 插件把整条标注渲染成"文本 + KaTeX 公式"的覆盖层。只做数学，不做完整 markdown。
>
> 本规格只覆盖内容层（识别、解析、渲染、编辑器、尺寸）。Σ 按钮定位、原生工具切换、
> MutationObserver、manager 补丁、comment-only 存储、KaTeX 字体 data URL 都不变。

## 0. 状态与相关文档

- 已实现并合入分支 `feat/rich-text-math`；2026-10-18 用户真机验证：插入、混排渲染、
  双击编辑基本正常。tag 形状错误已按 Zotero 源码修正。
- Zotero 运行时事实（tag / comment / data-id / manager）以
  [zotero-notes.md](zotero-notes.md) 为准；性能细节见
  [performance-optimization.md](performance-optimization.md)。
- 待做：侧栏编辑后的 rect 归一化、混排中超宽块级公式、字体视觉微调。

## 0.1 已确定的产品决策

- 识别采用 **tag 方案**：插件创建/编辑的标注带 `mathtool` tag，只有带 tag 的标注
  （以及旧前缀标注）才渲染。原生文本工具创建的标注完全不接管，原生编辑保持原样。
- 新建标注时输入不含 `$`，整段按**块级公式**处理（兼容旧输入习惯）。
- 编辑器去掉"大公式模式"复选框，统一混合文本。
- 不增加"行内/块公式"快捷按钮；行内/块级由 `$...$` / `$$...$$` 决定。
- 旧 `[[math:display]]` / `[[math:inline]]` 继续可读，编辑保存时迁移成新语法。

## 1. 识别

一条标注被视为"数学标注"当且仅当：

1. `annotation.type === "text"`；
2. 且满足其一：
   - `annotation.tags` 含 `mathtool`；
   - `comment` 含旧前缀 `[[math:display]]` 或 `[[math:inline]]`。

只有数学标注才进入隐藏原文 / overlay 渲染 / 双击编辑链路。普通 text 标注零改动。

tag 读取兼容 `{ name }` / `{ tag }` / string 和单对象形态；**写入只允许**
`{ name: "mathtool" }`（阅读器内部格式）。Zotero 保存时 `fromJSON` 用 `name` 生成条目
tag `{ tag }`；写 `{ tag }` 或字符串会报 `Tag data must contain 'tag' property`。

## 2. 语法

### 2.1 行内公式

```
设 $x$ 为变量，则 $x^2 \ge 0$。
```

- `$` 包裹，同一行内闭合。
- 开 `$` 后不能紧跟空白；闭 `$` 前不能是空白，且闭 `$` 后不能紧跟数字（Pandoc 规则，
  用来避免 `$5 and $10` 这类美元金额误判）。
- 行内公式不跨行。跨行请用 `$$`。

### 2.2 块级公式

```
设 $x$ 为变量，则

$$x^2 \ge 0$$

恒成立。
```

- `$$` 包裹，可以跨行；独占一行、居中渲染。
- 文本中 `$$...$$` 会切断当前文本行：公式前、公式后各成一段。
- `$$` 内可以自由出现单个 `$`，只有未转义的 `$$` 才闭合。

### 2.3 转义与边界

- 文本里的 `\$` 表示字面量 `$`，不进入公式。
- 文本里的 `\\` 表示字面量 `\`。
- 公式内的 `\$` 不当作闭合符，原样交给 KaTeX（KaTeX 渲染为 `$`）。
- 未闭合的 `$` / `$$`、空公式（`$$$$`、`$ $`）一律按普通文本处理，不吞内容。
- 旧前缀优先识别；新内容不会生成前缀。
- `\[...\]`、`\(...\)`、`\begin{equation}` 暂不支持（v1 只认 `$` / `$$`）。
  注意 `\displaystyle` / `\textstyle` 只改变数学样式，不是块级/行内切换；
  块级必须用 `$$`。

## 3. 文档模型

解析结果是顺序节点列表：

- `text`：普通文本，保留原文（含换行，渲染时 `white-space: pre-wrap`）；
- `inline-math`：行内公式 latex；
- `display-math`：块级公式 latex。

`mathCount` 为公式节点数；为 0 时不算数学标注。文档首尾空白在解析前去掉；
只含空白的文本节点如果紧邻块级公式，渲染时丢弃，避免空段落。

## 4. 渲染

- 一条标注一个 overlay（沿用现有 `.zotero-latex-math-manager-render` 结构）。
- **纯公式**（只有一个公式节点、没有普通文本；含 legacy 标注）继续走旧的
  `fit-content` + `fitFormulaToOverlay` 路径，保持原有公式渲染/缩放行为。
- **文本+公式混排**才走 rich 布局：文本块 + 行内/块级公式。
- 文本节点先做 HTML 转义，再插入；KaTeX 输出直接插入（`trust: false`）。
- 文本段用块级容器 + `white-space: pre-wrap`，行内公式作为其中的 inline span。
- 块级公式单独一个块容器，居中；`.katex-display` 的默认 margin 置 0。
- 公式渲染失败沿用现有 `renderLatex` 行为：`throwOnError: false` 输出红色错误。
- 字号优先读 `annotation.position.fontSize`，缺省 14；行高约 1.4；
  颜色沿用 `annotation.color`。
- 文本/公式的字体、行高、基线以真机对比原生文字标注后再定。

## 5. 编辑器

- 去掉模式复选框；输入框是混合文本，下方实时预览（输入防抖 80–120ms）。
- 新建（初始内容为空）：
  - 输入里能解析出公式 → 按混合文本保存；
  - 解析不出公式 → 整段包成 `$$...$$` 保存（块级公式）。
- 编辑已有标注：按原样保存；删掉全部公式就是有意变成普通文本（已有 tag 不主动移除，只是不再渲染）。
- 旧前缀标注打开时显示成 `$$...$$` / `$...$`，保存时迁移；取消不改。
- 保存前 `trim()`；空内容禁止保存。
- 预览与最终 overlay 必须共用同一套 CSS/字体；测量在编辑器 iframe 里完成
  （先渲染预览 → 强制布局 → `fonts.ready`），再按当前页 viewport scale 写回 rect。

## 6. 尺寸与缩放

- 创建/编辑保存时：按当前宽度排版，测量内容在 PDF 单位下的宽高，写回
  `annotation.position.rects`。纯公式保持现有紧凑尺寸；混合内容宽度自适应，
  上限约 220–320 PDF pt，超出换行，高度随内容增长。
- 渲染时：在 PDF 单位下排版（基础字号、宽度 = rect 宽 / zoom），再
  `transform: scale(zoom)` 跟随缩放。缩放不重排，沿用现有 fit 思路。
- 侧栏改 comment 后按宽度重算高度并写回 rect：**v1 未实现**（后续做）。现在靠
  overlay 整体缩小兜底；正常从插件插入/编辑的尺寸是准的。
- 内容高度与 rect 不匹配时，v1 用现有"缩小到 fit"兜底。

## 7. 性能

- 识别先看 tag / 旧前缀，O(1) 级别；不对普通标注解析 comment。
- 解析结果按 comment 缓存（上限 200）；KaTeX HTML 按 `(latex, display)` 缓存（上限 200）。
- 测量结果按"内容元素 + 宽度 + 字号"WeakMap 缓存，且 `document.fonts.status === "loaded"` 才缓存。
- 原文控件匹配用 `data-id`（标注 id）+ 无 id 时 value 回退；sources/ids 集合按标注数量缓存。
- overlay 只在内容变化时重建 innerHTML；稳态渲染只更新坐标/缩放。
- 保持现有 `readerHasMath` 的 O(1) 失效键与渲染短路；新增逻辑不得引入每帧全量扫描。

## 8. 不做

- 标题、列表、加粗/斜体、链接、图片、表格、代码块；
- 公式编号、交叉引用、`\begin{equation}`；
- 原生文本标注的自动渲染（tag 方案下不接管）；
- 更改 Zotero 原生文本工具行为。

## 9. 真机验证状态

已确认（2026-10-18）：

- tag 写入 `{ name }` 后保存不再报错；插入、混排渲染、双击编辑基本正常。
- 纯公式仍按旧路径渲染；文本+公式按 rich 布局渲染。
- 原生文本标注不被接管。

仍需逐项回归：

1. 重启 Zotero / 重开 PDF 后 `mathtool` tag 是否保留、是否仍渲染。
2. comment 换行是否在 `addAnnotation` / `updateAnnotations` / `_save` / 同步中原样保留。
3. 自定义高度/宽度 rect 是否持久化；内容出页面是否正常。
4. 侧栏编辑 comment 后的 overlay / rect 表现（当前用整体缩小兜底）。
   注意：插件自己的编辑路径会在调用 `updateAnnotations` 前就改好 manager 里的同一标注对象，
   不会触发 Zotero 按原始 `$...$` 文本重算 rect；**侧栏编辑**走 partial 更新，会触发
   `adjustTextAnnotationPosition`，长混排可能出现缩小/留白。
5. 100/150/200% 缩放下文字换行、基线与 rect 对齐。
6. 多公式标注滚动/缩放性能。

## 10. 实现进度

已完成：纯解析 + tag 判断 + 渲染 HTML 构建（`test/unit/richText.test.ts` 覆盖）、
编辑器去模式与混排预览、编辑器 iframe 内测量、`mathTool.ts` 接入（识别 / overlay /
创建更新 rect / 旧前缀迁移）。

待做：侧栏编辑 rect 归一化、混排超宽块级公式策略、字体/行高视觉微调、缓存上限实测。
