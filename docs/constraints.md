# 约束与决策

改代码前对照这两节。约束来自当前代码和 Zotero 10.0.x 的现状；方案是取舍，可以改，
但先在 `.agents/notes/proposed/` 写清理由和验证方法。

## 必须遵守

违反就是 bug。

**数据**

- 正文只读写 `annotation.comment`，读取走 `getMathContent`。`text` 恒为空，
  `text ?? comment` 不会回退，识别会失败（见 [zotero-runtime.md](zotero-runtime.md#标注数据)）。
- tag 只写 `{ name: "mathtool" }`。Zotero 保存时用 `t.name` 生成条目 tag，写字符串或
  `{ tag }` 会让保存抛错（见 [zotero-runtime.md](zotero-runtime.md#标注-tags)）。
- `updateAnnotations` 按 partial 处理：在原方法之后按 id 从 manager 取回合并后的完整标注，
  再判断是否渲染（见 [zotero-runtime.md](zotero-runtime.md#annotationmanager)）。

**边界**

- 原生文本标注零改动：无 tag、无旧前缀就不解析、不隐藏、不接管编辑。
- 编辑器 iframe 不出现在 `getRuntimeDocuments` 里，否则每次打开泄漏 observer。
- 新增的 observer、监听、document 引用必须能在 `disposeRuntime` 清理。

**渲染**

- 原文隐藏匹配以 `data-id` 优先、value 回退；反了会错配或让原文重新出现。
- 热路径不引入全量扫描：每轮每文档最多一次控件扫描，缓存按内容或元素自然失效。

**几何**

- 测量在编辑器 iframe 内完成；在 reader 文档里测必须用 `layoutScale` 换算
  （CSS px = PDF 单位 × viewport scale），否则高缩放下换行和高度都会错。

## 已定方案

- 纯公式走 `fit-content`，混排走 rich。既有标注都是纯公式，换布局会让历史标注视觉变化、
  宽公式横向溢出，见 [rect-fit-content](../.agents/notes/implemented/rect-fit-content.md)。
- 渲染保持 `renderIfNeeded` → `renderMathAnnotations` → `renderManagerOverlays` /
  `hideRawMathElements` / `getMathControlSets`。换入口会绕过热路径短路与缓存，见
  [performance.md](performance.md#热路径)；改结构要跑完整回归（见 [testing.md](testing.md)）。
- 颜色只用 Zotero 内置调色板。自定义取色的系统弹窗位置不可控，见
  [rejected/custom-color-picker](../.agents/notes/rejected/custom-color-picker.md)。
- KaTeX 字体 data URL 内联，不子集化、不换外部文件。PDF 页面加载不了 `chrome://`，
  见 [rejected/external-katex-fonts](../.agents/notes/rejected/external-katex-fonts.md)。
- 新建内容里没有 `$` 时整段当块级公式，保留"点开就写 latex"的习惯，见
  [rich-text-math](../.agents/notes/implemented/rich-text-math.md)。
