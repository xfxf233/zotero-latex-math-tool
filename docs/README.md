# 开发者文档

面向要改这个仓库的人（含 coding agent）。这里只写**现在**的项目事实：代码怎么组织、
运行时是什么样、哪些性质不能破坏。用户安装与使用说明见根目录 [README.md](../README.md) /
[README_zh.md](../README_zh.md)。

| 文档                                   | 读它是为了搞清楚                                         |
| -------------------------------------- | -------------------------------------------------------- |
| [architecture.md](architecture.md)     | 模块划分、启动与 reader 生命周期、插入/渲染链路、补丁点  |
| [constraints.md](constraints.md)       | 必须遵守的约束、已定方案及理由                           |
| [rich-text.md](rich-text.md)           | 标注内容的语法、识别、解析/渲染、编辑器与 rect 几何      |
| [zotero-runtime.md](zotero-runtime.md) | Zotero 内部行为中会直接影响本插件的事实（tag/comment/…） |
| [performance.md](performance.md)       | 渲染热路径、缓存、性能约束                               |
| [testing.md](testing.md)               | 构建、静态检查、单测、真机调试与回归清单                 |

## 约定

- 现在时，只写当前事实；改动历史、被否掉的方案、经验教训放
  [`.agents/notes/`](../.agents/notes/README.md)。
- 引用的函数名、class 名失效时顺手改掉。
