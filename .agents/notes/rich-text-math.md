---
status: implemented
proposed: 2026-10
settled: 2026-10
---

# 标注里混写文本与公式

## 问题

原来一条标注只能是一个公式（`[[math:display]]` / `[[math:inline]]` 前缀）。写推导时
"公式 + 一句解释"必须拆成多条标注，位置和阅读顺序都难控制。

目标：一条自由文本标注里混写普通文本、`$...$` 行内公式、`$$...$$` 块级公式，整条渲染
成一个 overlay。只做数学，不做 Markdown。

## 决策

**识别走 tag，不解析全部标注。** 插件创建/编辑的标注带 `mathtool` tag，只有带 tag 或
带旧前缀的标注才进入解析。代价是已有旧标注不会自动补 tag，要等下次在插件里编辑保存。

**纯公式保持原路径。** 只有公式节点、没有普通文本的标注（含所有 legacy 标注）继续走
`fit-content` + `fitFormulaToOverlay`；只有混排才走新的 rich 布局。原因：所有既有标注
都是纯公式，改成 rich 会让宽公式横向溢出、让历史标注视觉变化。这条现在写在
[docs/constraints.md](../../docs/constraints.md)。

**语法只做 `$` / `$$`。** 沿用 Pandoc 的边界规则（开 `$` 后不能是空白、闭 `$` 后不能
跟数字），否则 `$5 and $10` 会被误判成公式。

**新建时解析不出公式就整段当块级公式。** 用户原来的习惯是"点开就直接写 latex"。保留这个
行为，避免输入 `x^2` 变成一段普通文本。

**编辑器去掉"大公式模式"开关。** 行内/块级由 `$` / `$$` 决定，不再有第二个状态源。
输入框下方实时预览（防抖 100ms），预览与 overlay 共用同一套 CSS。

**颜色只用 Zotero 内置 9 色。** 见 [custom-color-picker](custom-color-picker.md)。

**存储只用 `comment`。** `text` 恒空，业务读取走 `getMathContent`；正文写入只写 comment，
并把 `text` 清空（dev diagnostics 仍会直接读 `annotation.comment`，仅调试用）。
这样在没有插件的设备上同步过去就是可读的源码。

**落到**：纯内容层 `src/richText/parse.ts`、`render.ts`、`layout.ts`，单测在
`test/unit/richText.test.ts`；Zotero 集成在 `src/math/`（`annotationData.ts` 识别与解析缓存、
`overlay.ts` / `renderer.ts` 渲染、`editor.ts` 编辑器、`measure.ts` / `geometry.ts` 尺寸
与坐标）。

## 考虑过但没选的

- **按内容解析决定是否接管**：comment 里能解析出公式就渲染。问题是会接管用户用原生
  文本工具写的 `$`，且每次渲染都要解析全部标注。
- **支持 `\(...\)` / `\[...\]`**：两套语法意味着两套边界规则和迁移路径，收益不足。

## 经验

1. **纯逻辑先落成无依赖层。** `parse.ts` / `render.ts` 不碰 Zotero 和 DOM，单测可以直接
   跑；Zotero 集成层只做接线。后来改语法时，改动几乎都停在纯层里。
2. **兼容旧数据比新功能更容易出回归。** 所有既有标注都是纯公式和旧前缀，任何"顺手
   统一"的重构都会伤到它们。评审新方案时，先把"旧数据走哪条路径"写进验收标准。
3. 判断新旧代码是否一致，比问"新功能好不好用"更容易发现回归；新的测量代码先问"这是
   什么坐标系、当前 scale 是多少"，再问公式对不对。

现状见 [docs/rich-text.md](../../docs/rich-text.md)。
