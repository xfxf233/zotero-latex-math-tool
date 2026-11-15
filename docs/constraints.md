# 约束与决策

改代码前对照这两节。约束来自当前代码和 Zotero 10.0.8 的现状；已定方案是取舍，可以改，
但先在 `.agents/notes/` 写一篇 `status: proposed` 的 note，写清理由和验证方法。

## 约束

**数据**

- 正文只读写 `annotation.comment`（更新时把 `text` 清空），读取走 `getMathContent`。
  `text` 恒为空，`text ?? comment` 不会回退，识别会失败
  （见 [zotero-runtime.md](zotero-runtime.md#标注数据)）。
- tag 只写 `{ name: "mathtool" }`。Zotero 保存时用 `t.name` 生成条目 tag，写字符串或
  `{ tag }` 会让保存抛错（见 [zotero-runtime.md](zotero-runtime.md#标注-tags)）。
- `updateAnnotations` 按 partial 处理：在原方法之后按 id 从 manager 取回合并后的完整标注，
  再判断是否渲染（见 [zotero-runtime.md](zotero-runtime.md#annotationmanager)）。

**边界**

- 原生文本标注零改动：无 tag、无旧前缀就不解析、不隐藏、不接管编辑。
- 编辑器 iframe 不出现在 `getRuntimeDocuments` 里，否则每次打开泄漏 observer。
- 新增的 observer、监听、document 引用必须能在 `disposeRuntime` 清理。
- 挂在 Zotero 对象上的包装入口必须判断 `state.alive`，shutdown 之后直接调用原方法；否则插件
  禁用后的拖拽/外部更新仍会跑旧沙箱的代码（见
  [shutdown-residue](../.agents/notes/shutdown-residue.md)）。

**渲染**

- 原文隐藏匹配以 `data-id` 优先、value 回退；反了会错配或让原文重新出现。
- 热路径不引入全量扫描：每轮每文档最多一次控件扫描，缓存按内容或元素自然失效。

**几何**

- 测量在编辑器 iframe 内完成；在 reader 文档里测必须用 `layoutScale` 换算
  （CSS px = PDF 单位 × viewport scale），否则高缩放下换行和高度都会错。

**结构**

- 跨模块共享的可变状态只放在 `src/math/state.ts` 的 `state` 里；模块之间只通过函数
  调用协作，不互相持有实例引用。新增 reader 级状态用 WeakMap/WeakSet 作键。
- import 方向单向：入口/生命周期 → 补丁/渲染 → 数据/几何/编辑器/工具。底层模块不得
  反向 import `mathTool.ts`、`patches.ts`、`readerInit.ts`。`insert.ts` 与
  `readerInit.ts` 的互需用注入 `ensureReader` 回调解决，不要直接互相 import。
- 需要显式释放的资源（observer、DOM 监听、定时器、注入样式）在
  `src/math/dispose.ts` 的 `disposeRuntime` 清理；只影响单个元素的临时资源用 WeakMap
  缓存，元素销毁后自动回收。
- 模块只 export 跨模块或测试需要的函数/常量，内部函数保持私有，避免模块边界退化。原因
  见 [module-split](../.agents/notes/module-split.md)。

## 已定方案

- 纯公式走 `fit-content`，混排走 rich。既有标注都是纯公式，换布局会让历史标注视觉变化、
  宽公式横向溢出，见 [rect-fit-content](../.agents/notes/rect-fit-content.md)。
- 渲染保持 `renderIfNeeded` → `renderMathAnnotations`（每 doc 一次
  `getElementsWithMathText`）→ `renderManagerOverlays` / `hideRawMathElements`。换入口会
  绕过热路径短路与缓存，见 [performance.md](performance.md#热路径)；改结构要跑完整回归
  （见 [testing.md](testing.md)）。
- 颜色只用 Zotero 内置调色板。自定义取色的系统弹窗位置不可控，见
  [custom-color-picker](../.agents/notes/custom-color-picker.md)。
- KaTeX 字体 data URL 内联，不子集化、不换外部文件。PDF 页面加载不了 `chrome://`，
  见 [external-katex-fonts](../.agents/notes/external-katex-fonts.md)。
- 新建内容解析不出公式时整段当块级公式，保留"点开就写 latex"的习惯，见
  [rich-text-math](../.agents/notes/rich-text-math.md)。
- 拆分后的模块边界与 `state` 集中式共享状态是当前形态，理由与取舍见
  [module-split](../.agents/notes/module-split.md)。
