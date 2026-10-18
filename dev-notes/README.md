# 开发笔记索引

> 面向开发/维护者。用户使用说明见仓库根目录 [README.md](../README.md) 与
> [doc/README-zhCN.md](../doc/README-zhCN.md)。

## 文档

| 文档                                                       | 内容                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [rich-text-spec.md](rich-text-spec.md)                     | 混合文本 + `$...$` / `$$...$$` 的识别、解析、渲染、编辑器、尺寸与实现状态      |
| [performance-optimization.md](performance-optimization.md) | PDF overlay 渲染热路径、已完成的优化、缓存与性能红线                           |
| [zotero-notes.md](zotero-notes.md)                         | Zotero 运行时事实：comment/text、tags 结构、AnnotationManager、data-id、字体等 |
| [../CLAUDE.md](../CLAUDE.md)                               | 跨会话交接：当前分支、红线、关键规则、验证流程                                 |

## 测试

两类测试分开，避免互相干扰：

- **纯逻辑单测**：`npm run test:rich-text`
  - 位置：`test/unit/richText.test.ts`
  - 运行环境：Node 22 `--experimental-strip-types`，不需要 Zotero
  - 覆盖：旧前缀、`$` / `$$`、转义、美元金额误判、块级/行内、tag 识别、HTML 转义
- **Zotero 集成测试**：`npm test`
  - 位置：`test/integration/`
  - 运行环境：需要 Zotero 二进制与 `.env`，本沙箱跑不了
  - 由 `zotero-plugin test` 在 Zotero 里执行 Mocha

为什么分开：`zotero-plugin test` 默认扫描 `test/**/*.{spec,test}.[jt]s` 并在 Zotero
进程里运行；纯 Node 的 `node:test` 文件混在 `test/` 下会被它误加载。因此：

- `zotero-plugin.config.ts` 的 `test.entries` 只指向 `test/integration`；
- `test/unit` 由 `npm run test:rich-text` 显式运行。

## 构建与静态检查

```bash
npm run build        # zotero-plugin build + tsc --noEmit
npx eslint src test
npx prettier --check .
```

构建产物：`.scaffold/build/zotero-latex-math-tool.xpi`。

## 真机调试

需要真实 DOM/运行时日志时（本沙箱没有 Zotero）：

```bash
npx zotero-plugin build --dev
(cd .scaffold/build/addon && zip -qr ../zotero-latex-math-tool.xpi .)
```

装进 Zotero → 帮助 > 调试日志 > 启用日志 → 查看输出日志，搜索 `render diagnostics`。
production build 会把 `__env__` 编成 `production`、诊断代码被短路，抓完记得重新
`npm run build` 再安装。
