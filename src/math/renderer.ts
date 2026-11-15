/**
 * 渲染链路编排：防抖调度、MutationObserver、每轮渲染、overlay 重定位，以及
 * "选中后再点一下"进入编辑的点击处理。
 *
 * 热路径的短路与缓存策略见 docs/performance.md。
 */
import type { MathContent } from "../richText/parse";
import { getString } from "../utils/locale";
import {
  getAnnotationFontSize,
  getAnnotationLayoutWidth,
  getMathAnnotations,
  getMathContent,
  getPDFPosition,
  parseAnnotationMath,
  readerHasMath,
} from "./annotationData";
import { updateManagerAnnotationByID } from "./annotations";
import {
  getPreferredAnnotationColor,
  normalizeAnnotationColor,
} from "./colors";
import {
  CLICK_DRAG_THRESHOLD_PX,
  EDITOR_FRAME_CLASS,
  MANAGER_RENDER_CLASS,
  PAGE_OVERLAY_CLASS,
} from "./constants";
import { logRenderDiagnostics } from "./diagnostics";
import { getEditorSource, openEditorInDocument } from "./editor";
import {
  getCurrentScale,
  getPDFViewport,
  getPDFViewportFromWindow,
  getPageIndex,
  getViewportPoint,
  getViewportRect,
} from "./geometry";
import {
  getElementsWithMathText,
  hideNewRawMathText,
  hideRawMathElements,
} from "./hiding";
import { logError } from "./log";
import { renderManagerOverlays } from "./overlay";
import { getPDFPageDocuments, getRuntimeDocuments } from "./readerDocs";
import { cloneValueIntoRealm } from "./realm";
import { state } from "./state";
import { injectStyles } from "./styles";
import type { ReaderRuntime } from "./types";

export function scheduleRender(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  repeat = false,
): void {
  const runtime = state.runtimes.get(reader);
  if (!runtime || runtime.disposed) {
    return;
  }

  if (runtime.renderTimer) {
    runtime.win.clearTimeout(runtime.renderTimer);
  }

  runtime.renderTimer = runtime.win.setTimeout(() => {
    runtime.renderTimer = undefined;
    renderIfNeeded(runtime);
  }, 50);

  if (repeat) {
    // 合并补帧定时器：插入/编辑路径会连续多次 scheduleRender(true)，不合并
    // 会堆积多个 750ms 定时器重复渲染。复用同一句柄、每次重置；dispose 时
    // 一并取消（见 disposeRuntime）。
    if (runtime.repeatTimer) {
      runtime.win.clearTimeout(runtime.repeatTimer);
    }
    runtime.repeatTimer = runtime.win.setTimeout(() => {
      runtime.repeatTimer = undefined;
      if (!runtime.disposed) {
        renderIfNeeded(runtime);
      }
    }, 750);
  }
}

/**
 * Only run the full render pass when there is math to display or stale
 * overlays to clean up.
 *
 * The MutationObserver fires on every PDF.js DOM change, so on annotation-
 * free PDFs the render path would otherwise run its full document scan on
 * each change. Skip it when there is neither an active math annotation nor
 * any leftover overlay — rendering then has nothing to do. Once an overlay
 * exists (or an annotation is present) the original render path runs
 * unchanged, so cleanup of removed annotations is preserved.
 */
function renderIfNeeded(runtime: ReaderRuntime): void {
  try {
    // readerHasMath 以 `_annotations.length` 为失效键、O(1) 缓存结果，
    // 缩放/翻页每帧调用时不用逐条 parse 标注内容（M4 保证编辑/保存路径
    // 显式失效缓存）。其余两个条件是轻量 DOM/集合查询。
    if (
      !readerHasMath(runtime.reader) &&
      !hasAnyManagerOverlay(runtime) &&
      !state.staleRawHiddenReaders.has(runtime.reader)
    ) {
      return;
    }
    renderMathAnnotations(runtime);
  } catch (error) {
    // reader 销毁过程中任何一步都可能抛错（死 wrapper 等）；记录并保证
    // 下一次调度照常，避免单次失败让原文长时间暴露。
    logError("Render pass failed", error);
  }
}

function hasAnyManagerOverlay(runtime: ReaderRuntime): boolean {
  for (const doc of getPDFPageDocuments(runtime)) {
    if (doc.querySelector(`.${MANAGER_RENDER_CLASS}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Re-run the render once per animation frame while a zoom is in progress.
 * The full render is idempotent and cheap when nothing changed, and the
 * short-circuits in `renderIfNeeded` make the common no-math case a no-op.
 * This is triggered only by scale changes, so it never fires during text
 * selection or other non-zoom DOM churn.
 */
function scheduleOverlaySync(runtime: ReaderRuntime): void {
  if (runtime.syncRAF !== undefined || runtime.disposed) {
    return;
  }
  runtime.syncRAF = runtime.win.requestAnimationFrame(() => {
    runtime.syncRAF = undefined;
    if (runtime.disposed) {
      return;
    }
    renderIfNeeded(runtime);
  });
}

export function refreshObservedDocuments(runtime: ReaderRuntime): void {
  for (const doc of getRuntimeDocuments(runtime)) {
    if (runtime.observedDocs.has(doc) || !doc.body) {
      continue;
    }

    injectStyles(doc);
    const win = doc.defaultView ?? runtime.win;
    runtime.observedDocs.add(doc);
    installRenderedFormulaDblClickHandler(runtime, doc);

    try {
      const Observer = win.MutationObserver ?? runtime.win.MutationObserver;
      const observer = new Observer((mutations: MutationRecord[]) => {
        // reader 销毁过程中 window 会变成死 wrapper，这里的 DOM/scale 访问
        // 可能抛错。异常会中断整个回调（当次 hideNewRawMathText 未执行），
        // 记录日志并让后续 mutation 批次照常处理，不因单次失败停止观察。
        try {
          if (shouldIgnoreMutations(mutations)) {
            return;
          }
          hideNewRawMathText(runtime, mutations);
          // A scale change means the page re-render was a zoom: the overlay
          // pixel rects are stale until re-positioned. Tracking the scale lets
          // us re-sync promptly during the zoom instead of only after it
          // settles (the debounced render), avoiding visible formula drift/flash.
          const scale = getCurrentScale(runtime);
          if (scale !== undefined && scale !== runtime.lastScale) {
            runtime.lastScale = scale;
            scheduleOverlaySync(runtime);
          }
          scheduleRender(runtime.reader);
        } catch (error) {
          logError("Unable to process reader document mutations", error);
        }
      });
      observer.observe(
        doc.body,
        createMutationObserverOptions(win) as MutationObserverInit,
      );
      runtime.observers.push(observer);
    } catch (error) {
      logError("Unable to observe reader document", error);
    }
  }
}

function createMutationObserverOptions(win: Window): MutationObserverInit {
  // P3: 观察面只保留能影响渲染的信号，纯 class / data-* 变更不再触发 observer。
  //   - childList: 缩放/翻页/编辑时 pdf.js 重建标注层、新增/移除控件节点
  //     （`hideNewRawMathText` 依赖它消除原文闪烁）。
  //   - characterData: 文本节点内容变化的兜底信号，内容变了就该重渲染。
  //   - attributes + attributeFilter=["style"]: 标注/overlay 的坐标尺寸由 style
  //     驱动（left/top/width/height/transform），style 变了才需要重新定位 overlay。
  //   去掉 class 与 data-* 后：
  //     - 文本选择、tooltip、hover 等纯 class 变更不再触发 observer，也就不会
  //       50ms 后白跑一遍全量渲染；
  //     - 我们隐藏原文时写的 `RAW_HIDDEN_CLASS` 不再自我触发一次防抖渲染
  //       （旧行为：每隐藏一个 textarea 都多排一次全量渲染，缩放时是批量的）。
  //   这几个属性都不影响 overlay 几何或 math 内容，无需重渲染；渲染链路是渲染时
  //   按需 querySelector 读 `data-page-number`/`data-annotation-id`，不依赖观察它们的
  //   变化（新增节点由 childList 保证被扫到）。
  const options: MutationObserverInit = {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["style"],
  };

  try {
    return Components.utils.cloneInto(options, win) as MutationObserverInit;
  } catch {
    return options;
  }
}

function shouldIgnoreMutations(mutations: MutationRecord[]): boolean {
  return mutations.every((mutation) => {
    if (!mutation.target) {
      return true;
    }

    const target =
      mutation.target.nodeType === 1
        ? (mutation.target as Element)
        : mutation.target.parentElement;
    if (!target) {
      return true;
    }

    return Boolean(
      target.closest(`.${PAGE_OVERLAY_CLASS}`) ||
      target.closest(`.${MANAGER_RENDER_CLASS}`) ||
      target.closest(".zotero-latex-math-modal") ||
      target.closest(`.${EDITOR_FRAME_CLASS}`),
    );
  });
}

function renderMathAnnotations(runtime: ReaderRuntime): void {
  refreshObservedDocuments(runtime);
  const docs = getPDFPageDocuments(runtime);
  const annotations = getMathAnnotations(runtime.reader);
  const sources = new Set<string>();
  const ids = new Set<string>();
  for (const annotation of annotations) {
    ids.add(annotation.id);
    const source = getMathContent(annotation).trim();
    if (source) {
      sources.add(source);
    }
  }
  // 每 doc 只做一次控件扫描，结果同时供 overlay 渲染与原文隐藏/清理使用，
  // 避免每轮渲染对同一文档的 textarea/input 全量扫描两遍（renderManagerOverlays
  // 判断有无数学源一遍 + hideRawMathElements 算 active 集合再一遍）。
  // 该结果在两步之间稳定：renderManagerOverlays 只增删我们自己的 overlay 元素，
  // 不会改变 textarea/input 控件的 value。
  const docMathElements = new Map<Document, HTMLElement[]>();
  for (const doc of docs) {
    docMathElements.set(doc, getElementsWithMathText(doc, sources, ids));
  }
  const overlayCount = renderManagerOverlays(
    runtime,
    docs,
    docMathElements,
    annotations,
  );
  // overlayCount > 0 走原有隐藏逻辑；无 overlay 但该 reader 被标记为有残留
  // 隐藏（数学标注被改成普通文本）时同样执行清理，否则普通文本会被残留的
  // 透明色遮住。正常路径（有 overlay）不增加任何查询。
  if (overlayCount > 0 || state.staleRawHiddenReaders.has(runtime.reader)) {
    for (const doc of docs) {
      hideRawMathElements(doc, docMathElements.get(doc) ?? [], sources, ids);
    }
  }
  state.staleRawHiddenReaders.delete(runtime.reader);
  logRenderDiagnostics(runtime, {
    docCount: docs.length,
    overlayCount,
  });
}

function installRenderedFormulaDblClickHandler(
  runtime: ReaderRuntime,
  doc: Document,
): void {
  // 选中状态下"再点一下"的编辑意图。pointerdown 时判定并只做标记，不拦截
  // 不弹：按下先不动，允许原生拖动注释框。pointerup 时若指针移动超过阈值
  // 视为拖动，撤销编辑意图（拖过松手不弹编辑器）；未拖动的松手才由
  // clickHandler 打开 LaTeX 编辑器。
  let pendingEdit = false;
  let downX = 0;
  let downY = 0;

  // 返回 true 表示事件落在"我们管理的阅读器表面"（而不是我们自己的
  // modal / 编辑器 iframe）。只有阅读器表面的点击才驱动选中与编辑。
  const isReaderSurfaceTarget = (event: Event): boolean => {
    const target = (event as MouseEvent).target as Element | null;
    return Boolean(
      target &&
      !target.closest(".zotero-latex-math-modal") &&
      !target.closest(`.${EDITOR_FRAME_CLASS}`),
    );
  };

  const openEditor = (
    event: Event,
    match: {
      annotation: _ZoteroTypes.Reader.Annotation;
      content: MathContent;
    },
  ) => {
    event.preventDefault();
    event.stopPropagation();
    (
      event as Event & { stopImmediatePropagation?: () => void }
    ).stopImmediatePropagation?.();
    const baseFontSize = getAnnotationFontSize(match.annotation);
    void openEditorInDocument(getEditorDocument(runtime), {
      initialSource: getEditorSource(match.annotation, match.content),
      isNew: false,
      baseFontSize,
      layoutWidth: getAnnotationLayoutWidth(match.annotation),
      // 编辑已有标注时从它当前的颜色开始，不拿记忆色覆盖。
      initialColor:
        normalizeAnnotationColor(match.annotation.color) ??
        getPreferredAnnotationColor(),
      title: getString("math-editor-edit-title"),
      onSave: async (source, renderedSize, color) => {
        await updateManagerAnnotationByID(
          runtime.reader,
          match.annotation.id,
          source,
          doc,
          baseFontSize,
          renderedSize,
          color,
        );
        scheduleRender(runtime.reader, true);
      },
    });
  };

  // 捕获阶段先于原生处理，读到的选中状态是"本次点击之前"留下的，
  // 从而区分第一次点击（仅选中）和"再点一下已选中公式"（待编辑）。
  const pointerDownHandler = (event: Event) => {
    pendingEdit = false;
    if (!isReaderSurfaceTarget(event)) {
      return;
    }
    const match = findMathAnnotationAtPoint(runtime, doc, event as MouseEvent);
    if (!match) {
      return;
    }
    if (!isAnnotationSelected(runtime.reader, match.annotation.id)) {
      return;
    }
    pendingEdit = true;
    downX = (event as MouseEvent).clientX;
    downY = (event as MouseEvent).clientY;
  };

  // 指针一旦移动超过阈值，视为拖动，撤销编辑意图。
  const pointerUpHandler = (event: Event) => {
    if (!pendingEdit) {
      return;
    }
    const mouseEvent = event as MouseEvent;
    const dx = mouseEvent.clientX - downX;
    const dy = mouseEvent.clientY - downY;
    if (dx * dx + dy * dy > CLICK_DRAG_THRESHOLD_PX * CLICK_DRAG_THRESHOLD_PX) {
      pendingEdit = false;
    }
  };

  const clickHandler = (event: Event) => {
    if (!isReaderSurfaceTarget(event)) {
      return;
    }
    const match = findMathAnnotationAtPoint(runtime, doc, event as MouseEvent);
    if (!match) {
      return;
    }
    if (!pendingEdit) {
      selectAnnotation(runtime.reader, match.annotation.id);
      return;
    }
    // 无拖动的松手 → 打开 LaTeX 编辑器，并拦截本次点击，避免原生进入
    // 隐藏原文的文本编辑态。
    pendingEdit = false;
    event.preventDefault();
    event.stopPropagation();
    (
      event as Event & { stopImmediatePropagation?: () => void }
    ).stopImmediatePropagation?.();
    openEditor(event, match);
  };

  // 双击事件只做拦截，防止原生双击进入隐藏原文的文本编辑态；
  // 弹编辑器已由上面的 click 处理，避免重复打开。
  const dblClickHandler = (event: Event) => {
    if (!isReaderSurfaceTarget(event)) {
      return;
    }
    if (!findMathAnnotationAtPoint(runtime, doc, event as MouseEvent)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    (
      event as Event & { stopImmediatePropagation?: () => void }
    ).stopImmediatePropagation?.();
  };

  doc.addEventListener("pointerdown", pointerDownHandler, true);
  doc.addEventListener("pointerup", pointerUpHandler, true);
  doc.addEventListener("click", clickHandler, true);
  doc.addEventListener("dblclick", dblClickHandler, true);
  runtime.documentCleanups.push(() => {
    doc.removeEventListener("pointerdown", pointerDownHandler, true);
    doc.removeEventListener("pointerup", pointerUpHandler, true);
    doc.removeEventListener("click", clickHandler, true);
    doc.removeEventListener("dblclick", dblClickHandler, true);
  });
}

function selectAnnotation(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  annotationID: string,
): void {
  const internalReader = reader._internalReader as any;
  const ids = cloneValueIntoRealm([annotationID], internalReader);

  if (internalReader?._state) {
    internalReader._state.selectedAnnotationIDs = ids;
  }

  for (const view of [
    internalReader?._primaryView,
    internalReader?._secondaryView,
    internalReader?._lastView,
  ] as any[]) {
    if (typeof view?.setSelectedAnnotationIDs === "function") {
      try {
        view.setSelectedAnnotationIDs(cloneValueIntoRealm(ids, view));
      } catch (error) {
        logError("Unable to select math annotation in reader view", error);
      }
    }
  }
}

function isAnnotationSelected(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  annotationID: string,
): boolean {
  const internalReader = reader._internalReader as any;
  const ids = internalReader?._state?.selectedAnnotationIDs;
  if (!Array.isArray(ids)) {
    return false;
  }
  return ids.includes(annotationID);
}

function getEditorDocument(runtime: ReaderRuntime): Document {
  return (
    state.readerDocs.get(runtime.reader) ??
    runtime.reader._window?.document ??
    runtime.doc
  );
}

function findMathAnnotationAtPoint(
  runtime: ReaderRuntime,
  doc: Document,
  event: MouseEvent,
):
  | {
      annotation: _ZoteroTypes.Reader.Annotation;
      content: MathContent;
    }
  | undefined {
  const target = event.target as Element | null;
  const page =
    (target?.closest(".page") as HTMLElement | null) ??
    (doc
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest(".page") as HTMLElement | null);
  if (!page) {
    return undefined;
  }

  const pageIndex = getPageIndex(doc, page);
  const viewport =
    getPDFViewportFromWindow(doc.defaultView, pageIndex) ??
    getPDFViewport(runtime, pageIndex);
  const point = getViewportPoint(page, event.clientX, event.clientY, viewport);
  const x = point.x;
  const y = point.y;
  const tolerance = 8;

  for (const annotation of getMathAnnotations(runtime.reader)) {
    const position = getPDFPosition(annotation);
    const content = parseAnnotationMath(annotation);
    const rect = position?.rects?.[0];
    if (!position || !content || !rect || position.pageIndex !== pageIndex) {
      continue;
    }

    const viewportRect = getViewportRect(runtime, doc, pageIndex, rect);
    if (!viewportRect) {
      continue;
    }

    if (
      x >= viewportRect.left - tolerance &&
      x <= viewportRect.left + viewportRect.width + tolerance &&
      y >= viewportRect.top - tolerance &&
      y <= viewportRect.top + viewportRect.height + tolerance
    ) {
      return { annotation, content };
    }
  }

  return undefined;
}
