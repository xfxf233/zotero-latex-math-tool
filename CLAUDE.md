# Zotero Latex Math Tool — 工作交接笔记

本文件是跨会话恢复工作状态的入口；细节不要继续堆在这里，放到 `dev-notes/` 对应文档。

## 项目是什么

Zotero 9+ 插件：PDF 阅读器工具栏加 Σ，点击 PDF 位置后插入/编辑公式或混合文本。
带 `mathtool` tag 的自由文本标注里可以混写普通文本、`$...$` 行内公式、`$$...$$` 块级公式；
插件用 KaTeX 把整条标注渲染成 overlay，并隐藏页面上的原始源码。双击渲染后的标注可编辑。
旧 `[[math:display]]` / `[[math:inline]]` 标注继续可读，编辑保存时迁移成 `$` / `$$`。
原生文本标注（无 tag）完全不接管，保持原生编辑。

核心：`src/mathTool.ts`（`LatexMathTool`，约 3600 行）；纯内容层 `src/richText/`
（`parse.ts` 解析、`render.ts` HTML 构建，不依赖 Zotero，可单测）。

## 沟通约定（用户偏好）

- **始终用中文回复。**
- 用户用 AI 开发、**不读代码**：给结论、风险、可操作建议，不要大段代码/文件 dump。
- **不确定就查，不要瞎猜**：用户本机装有 Zotero 10，路径 `E:\zotero`；`app\omni.ja`
  里是完整源码，可用 `tar -tf` / `tar -xOf` 直接查看（如
  `chrome/content/zotero/xpcom/annotations.js`、`resource/reader/reader.js`）。
  源码也查不到、或涉及实际交互和视觉效果时，直接请用户真机实测。
- 用户非常在意**不要拖慢 Zotero**。改动优先“增量/按需/复用”，但不牺牲已确认正常的功能。
- 只做数学 + 文本：换行、`$...$`、`$$...$$`、`\$`。不做标题/列表/加粗、公式编号、
  `\(...\)` / `\[...\]`。

## 当前状态

- 分支：`main`（`feat/rich-text-math` 已合入）。
- 2026-10-18 用户真机验证：插入、混合文本渲染、双击编辑、9 色调色板与颜色记忆正常；
  tag 结构问题已按 Zotero 源码修正。完整回归清单见下。
- 2026-10-19 纯公式的 rect 改为按 overlay 实际 fit-content 尺寸测量（不再用 rich
  容器，去掉行高/块级公式 margin 和 36pt 最小宽度），新插入/编辑保存后框贴合公式。
  混排的最小宽高改为兜底一个当前字号（原写死 36/20pt，小字号单行会被撑成两行高）。
  编辑保存改为保留当前 rect 宽度（不再被 320pt 自动换行宽度覆盖）；拖动左右边框
  时直接 patch `_primaryView.adjustTextAnnotationPosition`，在 Zotero 的重排里返回
  按渲染内容算好的 rect（同时绕过单行文本按源码回收宽度的逻辑），
  `updateAnnotations` 包装只作兜底。拖动时的测量在 reader 文档里，必须用
  `layoutScale` 做 viewport scale 换算（见规则 6）。原生文本标注不受影响。
  已有标注的旧 rect 不会自动改，拖动或编辑保存后才会按新规则重算。
- 2026-10-19 0.2.1 真机验证（用户确认）：左右拖动松手后框高按渲染内容收紧、
  宽度保持，不再需要手动点开保存；上下拖动保持用户拖出的高度。完整回归清单见下。
- 工作区可能有未暂存的文档/测试目录调整，提交前先 `git add -A`。

## ⚠️ 红线

1. **渲染/隐藏链路四方法**：`renderMathAnnotations`、`renderManagerOverlays`、
   `hideRawMathElements`、`getElementsWithMathText`。没有真机验证不要改结构。
   - 2026-08 已验证的例外：`staleRawHiddenReaders` 清理；预扫描控件集合复用。
   - 2026-10 混合文本改造：四方法改为传 annotations/sources/ids；`getElementsWithMathText`/
     `hideRawMathElements` 改为 **data-id 优先**、无 id 才回退 value 匹配。基本路径已被用户
     真机验证；**后续再动这四方法仍要做完整回归**。出现“原始 `$...$` + overlay 同时显示”时，
     优先查 data-id 匹配。
2. 本沙箱**没有 Zotero**：`npm test`（集成测试）跑不了；运行时行为一律靠用户真机验证。
   可以跑 `npm run build`、`tsc --noEmit`、eslint、prettier、`npm run test:rich-text`。

## 关键规则（必须记住）

1. 标注正文在 `comment`，`text` 恒空。读取一律 `getMathContent`（只读 comment），
   **不要 `text ?? comment`**；创建/保存只写 comment。
2. **tag 形状**：阅读器内部是 `{ name: "mathtool", color? }`；Zotero 保存时
   `fromJSON` 用 `name` 生成条目 tag `{ tag }`。插件**只写 `{ name }`**；写字符串或
   `{ tag }` 会报 `Tag data must contain 'tag' property`。识别时三种形态都兼容。
3. `addAnnotation` 只传最小入参（type/color/sortIndex/pageLabel/position/comment）；
   text 标注 `position.fontSize`/`rotation` 必需；`_save` 保留用于立即落库。
4. 原文控件 id 在 `data-id`（`data-annotation-id` 为空）；隐藏/hide 匹配以 data-id 为准，
   没有 id 才回退 value。
5. **纯公式**（只有一个公式节点、没有普通文本；含 legacy）继续走旧的
   `fit-content` + `fitFormulaToOverlay`；只有文本+公式混排才走 rich 布局。
   不要把纯公式改成 rich，否则宽公式会横向溢出、旧公式视觉会变。
6. 编辑器测量：先在 iframe 里渲染预览 → 强制布局 → 等 `editorDoc.fonts.ready` → 用与
   overlay 相同的 CSS 量出 PDF 单位宽高（混排用 rich CSS，纯公式用 fit-content DOM，
   清掉 `.katex-display` 的默认 margin）→ 按当前页 viewport scale 写回 rect。**不要**
   改回在 reader 文档里用未加载字体测量。万不得已要在 reader 文档里量（拖动后归一化）
   时，CSS px = PDF 单位 × viewport scale，必须传 `layoutScale` 换算后再除回来，
   否则宽度会被当成 CSS px，换行数变多、高度永远收不拢。
7. 识别先看 tag / 旧前缀，再解析 comment；解析结果、KaTeX HTML、rich 高度都有缓存。
   普通文本标注不解析。
8. 侧栏会看到 `mathtool` tag；旧标注只有在插件里编辑保存后才补 tag。
9. **`updateAnnotations` 入参可能是 partial**（侧栏只传 `{id, comment}` / `{id, tags}`）：
   必须在 `originalUpdateAnnotations` 之后按 id 从 manager 取回完整标注，再判断是否数学标注、
   是否调度渲染。不要直接对 partial 调 `parseAnnotationMath`（会漏渲染）。
10. **编辑器 iframe 必须从 `getRuntimeDocuments` 排除**（按 `frameElement` 的
    `zotero-latex-math-editor-frame` 类判断）；否则每次打开编辑器都可能被
    `refreshObservedDocuments` 观察并留下一个不释放的 MutationObserver/Document 引用。
11. **标注颜色**：编辑器只提供 Zotero 内置调色板（运行时 `Zotero.Annotations.COLORS`
    的 `[l10n key, hex]` 对 + 文本标注额外的黑色 `EXTRA_INK_AND_TEXT_COLORS`），不做
    自定义取色（原生 `input[type=color]` 的系统弹窗位置不可控，已放弃）。只有用户点
    色点才写 `annotation.color` 并把颜色记到 pref
    `extensions.zotero.mathtool.lastAnnotationColor`；只改正文不碰颜色，避免覆盖外部
    导入的非十六进制颜色。

## 文档索引

- [dev-notes/README.md](dev-notes/README.md)：开发文档索引 + 单测/集成测试怎么跑
- [dev-notes/rich-text-spec.md](dev-notes/rich-text-spec.md)：混合文本功能规格与实现状态
- [dev-notes/zotero-notes.md](dev-notes/zotero-notes.md)：Zotero 运行时事实（tag、comment、data-id、
  manager、字体等）
- [dev-notes/performance-optimization.md](dev-notes/performance-optimization.md)：渲染热路径与优化
- 用户说明：[README.md](README.md) / [doc/README-zhCN.md](doc/README-zhCN.md)

## 验证流程

```bash
npm run build                 # zotero-plugin build + tsc --noEmit
npx eslint src test
npx prettier --check .
npm run test:rich-text        # 纯解析/渲染单测，不需要 Zotero
```

- 修改后必须过以上命令。
- `npm test` 是 Zotero 集成测试（`test/integration/`），需要 Zotero 二进制和 `.env`，
  本沙箱无法运行。
- 需要真机 DOM/日志：`npx zotero-plugin build --dev` → 手动打 zip → 装进 Zotero →
  帮助 > 调试日志 > 启用日志 → 搜 `render diagnostics`。production 构建会短路诊断代码，
  抓完重新 `npm run build`。

### 真机回归清单

1. 新插入后重启 Zotero / 重开 PDF：`mathtool` tag 仍在，公式仍渲染。
2. comment 换行原样保留；多行混排正常。
3. rect 高度持久化；100/150/200% 缩放下文字/基线与选择框对齐。
4. 原生文本标注（无 tag，含 `$` 也不接管）保持原生编辑。
5. 侧栏把数学标注改成普通文本后，原文恢复显示，无残留透明隐藏。
6. **侧栏直接改数学标注的 comment（不是插件弹窗）**：overlay 会重新渲染，内容跟上；
   长混排可能因 Zotero 按原始 `$...$` 文本调整 rect 而出现缩小/留白（见剩余工作）。
7. 旧 `[[math:...]]` 标注照常渲染；编辑保存后迁移为 `$` / `$$`。
8. 混排 + 多公式标注的滚动/缩放性能。

## 剩余工作

- 侧栏编辑数学标注后按当前宽度重算高度并写回 rect（现在靠 overlay 整体缩小兜底）。
- 混排中的超宽块级公式目前可能横向超出标注框；需要决定是允许加宽还是单独缩放。
- 文本字体/行高与 Zotero 原生文字标注的视觉对齐（目前用 Helvetica/Arial 栈，真机微调）。
- `mathContentCache` 上限 200 可按实测调小；`findPageElement` 按页取集合暂缓。
