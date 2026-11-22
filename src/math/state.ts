/**
 * 插件级共享可变状态。
 *
 * 拆分前这些注册表/缓存/标记都是 `LatexMathTool` 的实例字段（定时器句柄在
 * `ReaderRuntime` 上，见 types.ts）；插件是单例（`Zotero.MathTool`），所以拆到模块后
 * 集中放在一个 `state` 对象里，模块之间只通过函数调用协作、不互相持有实例引用。按
 * reader / document / 元素作键的状态仍用 WeakMap/WeakSet，生命周期与原来一致。
 */

import type { MathContent } from "../richText/parse";
import type { AnnotationManager, ReaderRuntime } from "./types";

export const state = {
  // 插件是否仍在运行。shutdown 置 false 后，挂在 Zotero 对象上的包装函数直接调用原方法，
  // 避免禁用/卸载后旧闭包继续改页面或标注（见 shutdown-residue 那篇 note）。
  alive: true,
  toolbarHandler: undefined as
    _ZoteroTypes.Reader.EventHandler<"renderToolbar"> | undefined,
  runtimes: new WeakMap<_ZoteroTypes.ReaderInstance, ReaderRuntime>(),
  toolbarButtons: new WeakMap<
    _ZoteroTypes.ReaderInstance,
    Set<HTMLButtonElement>
  >(),
  readerDocs: new WeakMap<_ZoteroTypes.ReaderInstance, Document>(),
  watchedToolbarDocs: new WeakSet<Document>(),
  // 工具栏文档上的捕获监听清理函数（doc → cleanups）。doc 通常随阅读器窗口
  // 关闭而销毁，但禁用/卸载插件时窗口可能仍开着，需要显式移除监听。
  toolbarDocCleanups: new WeakMap<Document, Array<() => void>>(),
  nativeTextInsertReaders: new WeakSet<_ZoteroTypes.ReaderInstance>(),
  activatingReaders: new WeakSet<_ZoteroTypes.ReaderInstance>(),
  directInsertCleanups: new WeakMap<
    _ZoteroTypes.ReaderInstance,
    Array<() => void>
  >(),
  patchedManagers: new WeakSet<AnnotationManager>(),
  patchedViews: new WeakSet<object>(),
  patchedReaders: new WeakSet<_ZoteroTypes.ReaderInstance>(),
  // 已 uninit 的 reader。uninit 包装可能晚于初始化装上，所以关闭判定还得配合
  // `Components.utils.isDeadWrapper`，见 readerInit 的 isInitCancelled。
  closedReaders: new WeakSet<_ZoteroTypes.ReaderInstance>(),
  // in-flight 初始化的取消函数：uninit 与 shutdown 都调它，让等待中的初始化立即
  // 结束，而不是等 Zotero 的 promise 自己 settle（`initializedPromise` 可能永不
  // settle，见 reader-init-race 那篇 note）。
  readerInitAborts: new Map<_ZoteroTypes.ReaderInstance<"pdf">, () => void>(),
  runtimeSet: new Set<ReaderRuntime>(),
  lastRenderDiagnostics: new WeakMap<_ZoteroTypes.ReaderInstance, string>(),
  mathAnnotationCache: new WeakMap<_ZoteroTypes.ReaderInstance, boolean>(),
  // 侧栏编辑把数学标注改成普通文本后，残留的 RAW_HIDDEN_CLASS 会把文本染成
  // 透明不可见。该集合标记"此 reader 有需要清理的残留隐藏"，仅在编辑路径
  // 检测到残留时加入、渲染清理后移除，使 renderIfNeeded 热路径的检查保持 O(1)。
  staleRawHiddenReaders: new WeakSet<_ZoteroTypes.ReaderInstance>(),
  mathAnnotationCacheCounts: new WeakMap<_ZoteroTypes.ReaderInstance, number>(),
  // in-flight 的 ensureReader 初始化 Promise，防止并发调用对同一 reader
  // 重复建 runtime（见 readerInit.ts 的 ensureReader 注释）。
  ensureReaderPromises: new Map<
    _ZoteroTypes.ReaderInstance<"pdf">,
    Promise<ReaderRuntime>
  >(),
  mathModeBaselineTools: new WeakMap<
    _ZoteroTypes.ReaderInstance,
    string | undefined
  >(),
  // 每个 overlay 的 fit-content span 的天然排版尺寸，按 span 元素本身作键。
  // span 在 LaTeX 源/模式变化时被整体替换，因此条目随内容变化自然失效；
  // 且只在 document.fonts 就绪后读取缓存，见 `measureFitContent`。
  formulaContentSizeCache: new WeakMap<
    HTMLElement,
    { width: number; height: number }
  >(),
  // 混合内容按"内容元素 + 基准宽度 + 字号"缓存天然高度，稳态渲染不读布局。
  richContentSizeCache: new WeakMap<
    HTMLElement,
    { width: number; height: number; fontSize: number }
  >(),
  // 解析结果按 comment 原文缓存（纯函数、内容不变结果不变）；上限防止长文本
  // 标注无限增长。命中率在每次渲染/编辑都会被用到。
  mathContentCache: new Map<string, MathContent | null>(),
  // KaTeX 输出只由 (latex, display) 决定；多条标注/编辑器实时预览里重复公式
  // 很常见，缓存 HTML 可跳过重复的 renderToString。
  katexHtmlCache: new Map<string, string>(),
  // 每个 reader 的"数学标注原文集合 + 标注 id 集合"，用于 observer 热路径按
  // value / data-id 匹配隐藏，避免在 hideNewRawMathText 里反复解析所有标注。
  // 失效键与 readerHasMath 一致。
  mathControlCache: new WeakMap<
    _ZoteroTypes.ReaderInstance,
    { count: number; sources: Set<string>; ids: Set<string> }
  >(),
  // dev-only：patchAnnotationManager 各补丁的实际调用计数，用于确认
  // setAnnotations/updateAnnotations 包装是否真的被 Zotero 触发。
  setAnnotationsCalls: new WeakMap<_ZoteroTypes.ReaderInstance, number>(),
  updateAnnotationsCalls: new WeakMap<_ZoteroTypes.ReaderInstance, number>(),
};
