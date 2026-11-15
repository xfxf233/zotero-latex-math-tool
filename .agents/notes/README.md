# Agent Notes

这里放代码和 commit 里写不出来的东西：为什么选这个方案、哪些路试过走不通、被否决的
理由、事后能带走的经验。面向未来的维护者和新开的 agent。

`docs/` 写**现在是什么样**；这里写**为什么是这样**。两者不要互相抄。

一篇 note 认领一个主题。想法、决策、否决理由、经验都在同一个文件里。它现在停在哪一步，看 frontmatter 的 `status:`。

## 状态

| status        | 含义                   | 怎么读                           |
| ------------- | ---------------------- | -------------------------------- |
| `proposed`    | 方案还没落地           | 待解决的问题，和用户讨论后再执行 |
| `implemented` | 已落地，随代码同批更新 | 现状的依据                       |
| `rejected`    | 审慎否掉的路           | 别重走；条件变了才重新开一篇     |

状态的唯一来源是 frontmatter；索引里那一列跟着改，两处必须一致。

## 什么时候要写

三种情况值得开一条 note：

1. 改动了用户可见行为或数据格式（`comment` 语法、tag 形状、pref 名、rect 语义）；
2. 多个方案里做了取舍，且取舍不明显，或被迫回退；
3. 用户明确否决过某条路。

同一段理由在对话里被解释了第二遍，也是信号：它可能比较重要。此时询问用户是否写一个 note。

其余（修小 bug、调样式、加函数、改文档）靠 commit message 说清即可。触发后也不必走满
全流程：小决策直接写一条 `status: implemented` 的 note，不用先提 proposed。

实现中发现某条路不可行，或用户明确否决：**停下来**，把这条路记下来（已有主题就写进
那篇，新主题另起一篇 `status: rejected`），再继续别的。

**开新篇之前先搜旧篇**：按 slug、机制名、类名 grep 一遍。命中就并进已有那篇，或两篇
互链，不要为同一件事开第二个文件。

## 写法

固定小节，缺的整节不写，不留空节：

- implemented：`## 问题` → `## 决策` →（可选）`## 考虑过但没选的` →（可选）`## 经验`
- proposed：`## 问题` → `## 方案` →（可选）`## 风险` → `## 验收`
- rejected：`## 想法` → `## 为什么不成立` →（可选）`## 后续约束` →（可选）`## 经验`

- 文件名用英文 kebab-case slug，全仓库唯一，不带日期；内容用中文。
- 与代码在**同一个 commit** 里提交，保证说明和代码对得上。
- 现在时。事实（路径、函数名、默认值、缓存键）随代码**就地更新**，让它任何时候打开
  都描述 HEAD；决定或理由翻转才新开一篇并互链，不要把原篇结论改成反面。
- 不复述 `docs/` 里的现状，需要时链接过去；一个事实只在一处讲透。
- 一篇超过约 1.5 页，或含两个独立的"为什么"，就该拆。

## 索引

| Note                                                                  | 状态        | 一句话                                                    |
| --------------------------------------------------------------------- | ----------- | --------------------------------------------------------- |
| [module-split](module-split.md)                                       | implemented | mathTool.ts 拆成门面 + src/math/ 模块 + 集中 state        |
| [rich-text-math](rich-text-math.md)                                   | implemented | 标注里混写文本与公式的识别、渲染、编辑器方案              |
| [rect-fit-content](rect-fit-content.md)                               | implemented | 纯公式 rect 按 fit-content 测量，拖动时接管 Zotero 的重排 |
| [render-hot-path](render-hot-path.md)                                 | implemented | 渲染热路径的短路、扫描与缓存策略                          |
| [external-katex-fonts](external-katex-fonts.md)                       | rejected    | 字体改用外部文件与 `chrome://` 引用，PDF 页面加载不了     |
| [custom-color-picker](custom-color-picker.md)                         | rejected    | 任意取色，系统取色弹窗位置不可控                          |
| [sidebar-edit-rect-normalization](sidebar-edit-rect-normalization.md) | proposed    | 侧栏改 comment 后按宽度重算 rect                          |
| [wide-display-math](wide-display-math.md)                             | proposed    | 混排中超宽块级公式的处理策略                              |
| [text-font-alignment](text-font-alignment.md)                         | proposed    | 混排文本字体/行高与原生文本标注对齐                       |
