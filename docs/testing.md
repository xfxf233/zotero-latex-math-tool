# 构建、测试与验证

## 环境边界

本仓库**没有可自动运行的 Zotero 测试环境**，也没有集成测试。能自动验证的只有构建、类型、
lint 和纯内容层单测；运行时行为（DOM、几何、视觉）必须由人在真实 Zotero 里验证。

## 命令

```bash
npm install
npm run build          # zotero-plugin build + tsc --noEmit
npm run lint:check     # prettier --check . && eslint .
npm run lint:fix
npm run test:rich-text # 纯解析/渲染单测，不需要 Zotero
```

- `npm run build` 产出 `.scaffold/build/zotero-latex-math-tool.xpi`。
- 改完代码至少要过 `build` + `lint:check`。
- 提交前跑 `npx prettier --write .` 更省事（仓库用 prettier 统一格式）。

## 单测

`test/unit/richText.test.ts`，直接 `node test/unit/richText.test.ts` 跑，无框架。类型剥离是 Node
自带的：22.18+ / 23.6+ 默认开启，24.12 / 25.2 起转为稳定特性，不需要任何 `--experimental-*`
参数。CI 的 Node 来自 `setup-js` 的默认值 `lts/*`，本地与 CI 走同一条路径。

覆盖：旧前缀识别、`$` / `$$`、转义、美元金额误判、块级/行内、tag 判断、HTML 转义。
纯解析层（`src/richText/`）不依赖 Zotero / DOM / KaTeX，新增解析规则时应优先在这里补用例。

## 事实核查

事实的优先级：仓库代码 > 安装版源码 > 真机，
冲突时告知用户。

安装版 Zotero 在 `E:\zotero\app\omni.ja`，版本看 `E:\zotero\app\application.ini`。包内是
构建产物，与用户实测的版本一致：

```powershell
tar -tf E:\zotero\app\omni.ja | Select-String 'xpcom/annotations.js'
tar -xf E:\zotero\app\omni.ja -C <临时目录> chrome/content/zotero/xpcom/annotations.js
```

常用位置：`chrome/content/zotero/xpcom/**`（Zotero 本体逻辑）、
`resource/reader/reader.js`（阅读器打包产物，含 AnnotationManager 与标注 DOM）。

需要真实 DOM 或运行时日志时，用 dev 构建 + `render diagnostics` 日志，或
直接请用户看效果。

```bash
npx zotero-plugin build --dev
# dev 构建只产出 .scaffold/build/addon/，需要手动打包成 .xpi
#   Windows: Compress-Archive -Path .scaffold/build/addon/* -DestinationPath ../<name>.xpi
#   macOS/Linux: (cd .scaffold/build/addon && zip -qr ../<name>.xpi .)
```

装进 Zotero → 帮助 > 调试日志 > 启用日志 → 搜 `render diagnostics`。

**注意**：抓完日志要重新 `npm run build` 再安装。production 构建会把
`__env__` 编成 `production`，诊断代码被短路。

## 人工回归清单

改动插入、编辑、渲染/隐藏、几何中任一条路径后，逐项在真机上过一遍。清单里的行为
（渲染、拖动、缩放、颜色）在沙箱里无法观察，自动化只能挡住编译错误和纯逻辑问题。

1. 新插入公式后重启 Zotero / 重开 PDF：`mathtool` tag 仍在，公式仍渲染。
2. `comment` 里的换行原样保留；多行混排正常。
3. rect 高度持久化；100% / 150% / 200% 缩放下文字、基线与选择框对齐。
4. 原生文本标注（无 tag，内容含 `$`）保持原生编辑，不被接管。
5. 侧栏把数学标注改成普通文本：原文恢复显示，无残留透明隐藏。
6. 侧栏直接改数学标注的 `comment`：overlay 内容跟上。长混排可能因 Zotero 按原始源码
   重排 rect 而出现缩小/留白（已知限制）。
7. 旧 `[[math:display]]` / `[[math:inline]]` 标注照常渲染，编辑保存后迁移为 `$` / `$$`。
8. 拖动左右边框：松手后高度按渲染内容收紧、宽度保持；上下拖动保留用户拖出的高度。
9. 双击渲染后的标注可再次编辑；保存后框贴合内容。
10. 9 色调色板与阅读器右键改色一致；颜色偏好重启后仍生效。
11. 混排 + 多公式标注的滚动、缩放不卡顿。
