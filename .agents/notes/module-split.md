---
status: implemented
proposed: 2026-11
settled: 2026-11
---

# 拆分 mathTool.ts：模块边界、集中式 state 与逐方法等价验证

## 问题

`src/mathTool.ts` 一个文件 4366 行、一个 `LatexMathTool` 类装下了工具栏、插入模式、
Zotero 补丁、渲染调度、overlay、几何测量、编辑器、颜色和诊断。读一条链路要在巨型类里
上下跳；改任何一处都得先确认它有没有被别的路径复用。

但这是纯重构：插件没有 Zotero 自动化测试环境，沙箱里只能跑类型检查、打包和纯内容层
单测，运行时行为（DOM、几何、视觉）只能靠人真机验证。所以拆分的第一目标不是"结构更
漂亮"，而是**证明拆分没有改变行为**。

## 决策

1. **三层结构**：`src/mathTool.ts` 只留 `LatexMathTool` 门面（`startup` / `shutdown` /
   `disposeWindow`）；Zotero 集成逻辑放 `src/math/` 的约 25 个模块；纯内容层判断放
   `src/richText/`。拆分后最大的模块约 540 行。
2. **状态集中**：原类里的 26 个 WeakMap/WeakSet/Set/Map/句柄全部搬进
   `src/math/state.ts` 的 `state`。模块之间只通过函数调用协作，不互相持有实例。插件本来
   就是单例，集中式 state 与实例字段的生命周期一致，且新增跨模块状态时不用再造一层传递。
3. **单向依赖**：入口/生命周期 → 补丁/渲染 → 数据/几何/编辑器/工具；底层模块不反向
   import `mathTool.ts`、`patches.ts`、`readerInit.ts`。
4. **`insert.ts` ↔ `readerInit.ts` 用回调注入**：插入后要确保渲染 runtime，初始化又要
   patch 标注管理器并回调 `captureNativeTextAnnotation`，两边直接 import 会成环。
   `startup` 调 `startToolbarIntegration(ensureReader)` 注入初始化入口，依赖图保持单向。
5. **方法体逐字搬迁**：先用一次性脚本按 TypeScript AST 提取类成员、按映射表生成模块
   文件（`this.field` → `state.field`，`this.method()` → 函数调用），再人工补
   `types.ts` / `constants.ts` / `state.ts` / 门面 / 注入回调 / 模块头注释。不是重写逻辑。
6. **等价验证**：把 git HEAD 版每个方法体与拆分后的函数体做规范化比较——把
   `this.X`、`state.X`、裸函数调用统一成占位符，再用 TypeScript printer 去掉注释和
   格式差异后逐字符比对。142 个方法全部一致；其中 3 个生命周期方法是重写（人工核对），
   `ensureReader` 调用改为注入的 `ensureReaderReady`（语义等价）。26 个字段、全部顶层
   类型与常量的搬移也逐项核对通过，import 环为 0。
7. **顺手收口**：纯公式判定 `getSingleFormula` 与 legacy 迁移 `legacyToRichSource` 下沉到
   `src/richText/layout.ts` 并补单测；模块只导出跨模块使用的函数。

等价性证据：拆分前后 `npm run build`、`tsc --noEmit`、`eslint`、`prettier`、
`test:rich-text` 均通过；打包产物正常生成。

## 考虑过但没选的

- **拆成多个协作类 + 依赖注入接口**：`this.foo` 要逐一改成 `this.deps.foo`，改动面更大，
  且"逐方法等价"的核对难度反而上升。单例插件里函数 + 集中 state 足够清晰。
- **TS mixin / prototype 合并**：能保持方法体里的 `this` 不变，但方法签名要重复声明或
  依赖接口合并，维护两处，读起来不直观。
- **每个模块各自持有状态**：状态分散在二十个模块里，shutdown/reset 和"谁改了这个
  reader"都更难追；集中式 state 更容易一次审完。
- **只抽小工具、保留巨型类**：不解决"一条链路跨 4000 行"的主问题。

## 经验

- **搬代码也可以有证据**：脚本化搬迁 + 规范化逐方法比较，比人肉重写可靠得多。真正的
  风险不在"搬错一行"，而在引用改写（`this.` → 谁的函数）和状态归属；比较脚本正好覆盖
  这两类错误。
- **AST 取成员起点要用注释范围或声明行**：`getFullStart()` 会把上一个成员的收尾 `}`
  带进下一个函数，生成的文件里会多出孤立的 `}`。
- **TypeScript printer 的排版不稳定**：trailing comma、换行位置会随输入格式变化，比较前
  必须规范化空白与尾逗号，否则全是假阳性。
- **模块级 state 的生命周期**：`addon/bootstrap.js` 每次 `startup` 都重新
  `loadSubScript` 整个 bundle，模块状态随新沙箱重建，不会跨禁用/启用累积。仍然必须在
  `shutdown`/`disposeRuntime` 里清的是挂在 Zotero 对象和 DOM 上的监听、observer、定时器
  与注入样式——沙箱重建后旧闭包不会再被引用，但监听器还挂在原对象上。
- 拆分不改逻辑，但真机行为仍要按 [docs/testing.md](../../docs/testing.md) 的回归清单过一遍；
  编译、打包、纯单测只能挡住机械错误。

现状与约束见 [docs/architecture.md](../../docs/architecture.md)、
[docs/constraints.md](../../docs/constraints.md)。
