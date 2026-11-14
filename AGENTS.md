# AGENTS.md

Zotero 9+ 插件：PDF 阅读器工具栏加 Σ，在自由文本标注里混写普通文本、`$...$` 行内公式、
`$$...$$` 块级公式，插件用 KaTeX 把整条标注渲染成 overlay 并隐藏原文。只有带
`mathtool` tag 的标注会被接管，原生文本标注保持原样。

## 先读什么

- 要改代码：从 [docs/README.md](docs/README.md) 开始；动手前读
  [docs/constraints.md](docs/constraints.md)，碰渲染、隐藏、测量、存储时必读。
- 要判断"为什么这么做 / 该不该做"：读 [.agents/notes/README.md](.agents/notes/README.md)
  的索引，再打开对应的 note。`docs/` 是现状，`.agents/notes/` 是原因与取舍。

## 代码入口

| 位置                                   | 内容                                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/mathTool.ts`                      | 唯一的 `LatexMathTool` 类：工具栏、插入/编辑、Zotero 补丁、渲染链路、几何测量（约 4400 行，占绝大部分逻辑） |
| `src/richText/parse.ts`、`render.ts`   | 纯内容层：语法解析与 HTML 构建，不依赖 Zotero，可单测                                                       |
| `src/katexFonts.ts`                    | 20 个 woff2 的 data URL                                                                                     |
| `src/styles.css`                       | overlay / 编辑器样式                                                                                        |
| `src/hooks.ts`、`addon.ts`、`index.ts` | 生命周期与插件实例                                                                                          |
| `addon/`                               | manifest、bootstrap、locale、图标                                                                           |

## 环境

- **本沙箱没有 Zotero，也没有集成测试。** 运行时行为（DOM、几何、视觉、真实 PDF 交互）
  一律由用户真机验证；改完请给出需要验证的具体点，而不是说"应该没问题"。
- 用户不读代码：给结论、风险、可操作建议，不要大段贴代码或文件内容。
- 可以自动验证的：`npm run build`（含 `tsc --noEmit`）、`npm run lint:check`、
  `npm run test:rich-text`。细节见 [docs/testing.md](docs/testing.md)。

## 事实与证据

写进文档或结论的每条事实都要能指出依据。按下面的顺序取，冲突时以靠前的为准
（视觉、交互这类只有真机能判断的除外）：

1. **本仓库代码**：当前行为的第一来源，必要时补单测。
2. **Zotero 安装版源码**：`E:\zotero\app\omni.ja`，版本见 `E:\zotero\app\application.ini`。
   `tar -tf` / `tar -xOf` 直接读；它和用户实测的是同一版本，权威。
3. **Zotero GitHub 仓库**（可选）：注释和 TS/TSX 结构更清楚，但 `main` 是下一版开发分支，
   必须按安装版版本 checkout tag；与 omni.ja 冲突时以 omni.ja 为准。
4. **真机观测**：视觉、手感、时序只能这样验证。记清缩放级别、PDF、日志行；它只能证明
   "观察到过"，不能证明"不存在"。

做不到任何一条就标 `(推断)`，不要写成事实。文档里的 Zotero 结论按 `(源码)` / `(真机)` /
`(推断)` 标注。核实命令见 [docs/testing.md](docs/testing.md#事实核实)。

## 工作方式

- **约束与已定方案在 [docs/constraints.md](docs/constraints.md)，不在本文件维护。** 约束是
  现状，不能违反；已定方案是取舍，可以改——但先在 `.agents/notes/proposed/` 写清"换什么、
  证据、怎么验证"，评审通过后同时改代码和文档，不要静默绕过。
- 触及用户可见行为、数据格式（comment 语法 / tag / pref / rect 语义）、或做过方案取舍：
  在**同一个 commit** 里加 `.agents/notes/implemented/<slug>.md`。
- 实现中发现某条路不可行，或用户明确否决：停下来，写 `rejected/<slug>.md` 说明原因，
  再继续别的。
- 修 bug、调样式、小重构：commit message 说清即可，不写 note。
- note 里的事实（路径、函数名、默认值、缓存键）随代码**就地更新**，让它任何时候打开都
  描述 HEAD；只有决定翻转才新开一篇并互链。
- 流程细节见 [.agents/notes/README.md](.agents/notes/README.md)。

## 改动边界

- 只改被要求的部分。顺手发现的问题写进回复，不要顺手改掉。
- 不做的事不留说明：删掉的功能、否决的方案，不要写成"为什么不加 X"或"此处已移除"。
  确有留档价值的放 `.agents/notes/rejected/`，`docs/` 和代码注释里不写。
- 新增的每段文档、每条注释，先能回答"谁会在什么时候读它"；答不上来就删。
- 提交信息不要犯“番茄炒蛋（无东坡肉）”这种笑话。

## 用户偏好

- **始终用中文回复。**
- 不确定就查（源码或真机），不要瞎猜；涉及实际交互和视觉效果时直接请用户实测。
- 用户非常在意不要拖慢 Zotero：改动优先增量、按需、复用，但不牺牲已确认正常的功能。
