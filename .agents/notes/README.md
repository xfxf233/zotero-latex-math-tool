# Notes：为什么这么做

这里放代码和 commit 里写不出来的东西：为什么选这个方案、哪些路试过走不通、被否决的
理由、尘埃落定后能带走的经验。面向未来的维护者和新开的 agent。

`docs/` 写**现在是什么样**；这里写**为什么是这样**。两者不要互相抄。

## 什么时候要写

只有三种情况值得开一条 note：

1. 改动了用户可见行为或数据格式（`comment` 语法、tag 形状、pref 名、rect 语义）；
2. 多个方案里做了取舍，且取舍不明显，或被迫回退；
3. 用户明确否决过某条路。

同一段理由在对话里被解释了第二遍，也是信号：它值得写下来，别留在聊天里。

其余（修 bug、调样式、加函数、改文档）靠 commit message 说清即可。触发后也不必走满
全流程：小决策直接写 `implemented/` 一句话，不需要先提 `proposed/`。

**开新篇之前先搜旧篇**：按 slug、机制名、类名 grep 一遍 `proposed/`、`implemented/`、
`rejected/`。命中就并进已有那篇，或两篇互链，不要为同一件事开第二个文件。

## 目录

| 目录           | 放什么                                       | 时态 |
| -------------- | -------------------------------------------- | ---- |
| `proposed/`    | 想解决什么、有哪几种做法、倾向哪个、怎么验收 | 将来 |
| `implemented/` | 最终怎么做的、为什么这么定、落到哪些代码位置 | 现在 |
| `rejected/`    | 为什么这条路走不通（含"实现后被推翻/回退"）  | 过去 |
| `retro/`       | 事后能带走的经验，不复述实现                 | 现在 |

`retro/` 有料才写，不是每篇决策的必经站：只在有能迁移到下一个问题的经验时写，≤1 页，
正文只链接 `implemented/` 或 `rejected/`，不复制实现细节。

## 生命周期

```
proposed ──评审通过──> implemented ──有经验可带走──> retro（可选）
    │                       │
    └──评审否决──> rejected <── 实现后被推翻/回退
```

- `implemented/` 必须与代码在同一个 commit 里提交，保证说明和代码对得上。
- 实现过程中一旦确认某条路不可行，或用户明确拒绝：**停下来**，把那条路写进 `rejected/`
  说明原因，再继续别的。
- note 与代码共存亡：**事实就地改**（路径、函数名、默认值、缓存键），让它任何时候打开
  都描述 HEAD；决定或理由翻转才新开一篇并互链，不要在原篇把结论改成反面。
- 某篇 note 被完全取代、且新篇已吸收它的全部独特内容：删掉旧篇；还剩独立参考价值
  （否掉的路线、重新引入条件）就移进 `retro/`。

## 命名与格式

- 文件名用英文 kebab-case slug，全仓库唯一；同一个想法在四个目录里用同一个 slug。
- 内容用中文，开头一段 frontmatter：

```markdown
---
status: proposed | implemented | rejected | retro
proposed: 2026-10
settled: 2026-10-18
---
```

- 跨目录互链用相对路径，例如 `proposed/` 里的文件指向 `../implemented/<slug>.md`。
- 不复述 `docs/` 里的现状，需要时直接链接过去；一个事实只在一处讲透。
- 新增、改名、删除 note 时，同步改下面的索引。

## 索引

| Note                                                                           | 状态        | 一句话                                                    |
| ------------------------------------------------------------------------------ | ----------- | --------------------------------------------------------- |
| [rich-text-math](implemented/rich-text-math.md)                                | implemented | 标注里混写文本与公式的识别、渲染、编辑器方案              |
| [rect-fit-content](implemented/rect-fit-content.md)                            | implemented | 纯公式 rect 按 fit-content 测量，拖动时接管 Zotero 的重排 |
| [render-hot-path](implemented/render-hot-path.md)                              | implemented | 渲染热路径的短路、扫描与缓存策略                          |
| [external-katex-fonts](rejected/external-katex-fonts.md)                       | rejected    | 字体改用外部文件与 `chrome://` 引用，PDF 页面加载不了     |
| [custom-color-picker](rejected/custom-color-picker.md)                         | rejected    | 任意取色，系统取色弹窗位置不可控                          |
| [sidebar-edit-rect-normalization](proposed/sidebar-edit-rect-normalization.md) | proposed    | 侧栏改 comment 后按宽度重算 rect                          |
| [wide-display-math](proposed/wide-display-math.md)                             | proposed    | 混排中超宽块级公式的处理策略                              |
| [text-font-alignment](proposed/text-font-alignment.md)                         | proposed    | 混排文本字体/行高与原生文本标注对齐                       |
| [rich-text-math (复盘)](retro/rich-text-math.md)                               | retro       | 混排功能落地过程中的经验                                  |
| [external-katex-fonts (复盘)](retro/external-katex-fonts.md)                   | retro       | 资源加载环境的边界                                        |
