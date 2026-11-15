/**
 * overlay DOM：每条标注一个元素，纯公式按 fit-content 贴合、混合内容按 rich 布局排版，
 * 内容变化才重建 innerHTML。
 */
import { getSingleFormula } from "../richText/layout";
import type { MathContent } from "../richText/parse";
import {
  getAnnotationFontSize,
  getMathContent,
  getPDFPosition,
  parseAnnotationMath,
} from "./annotationData";
import {
  FIT_CONTENT_CLASS,
  MANAGER_RENDER_CLASS,
  PAGE_OVERLAY_CLASS,
  RICH_CONTENT_CLASS,
  RICH_LINE_HEIGHT,
} from "./constants";
import {
  setDatasetIfChanged,
  setStyleIfChanged,
  toggleClassIfChanged,
} from "./dom";
import { findPageElement, getCurrentScale, getViewportRect } from "./geometry";
import { renderLatex, renderRichContentHtml } from "./katex";
import { state } from "./state";
import { injectStyles } from "./styles";
import type { ReaderRuntime, ViewportRect } from "./types";
import { clamp, escapeCSSAttributeValue } from "./util";

export function renderManagerOverlays(
  runtime: ReaderRuntime,
  docs: Document[],
  docMathElements: Map<Document, HTMLElement[]>,
  annotations: _ZoteroTypes.Reader.Annotation[],
): number {
  let rendered = 0;

  for (const doc of docs) {
    injectStyles(doc);
    const activeIDs = new Set(annotations.map((annotation) => annotation.id));

    // Only render overlays on documents that actually host the annotation
    // source controls. Zotero instantiates hidden duplicate PDF views
    // (primary/secondary), so a document can contain `.page` elements with
    // no math text at all — rendering an overlay there is pure waste.
    // Documents without a math source are cleaned, not rendered.
    // mathElements 由 renderMathAnnotations 统一扫描后传入，避免重复全量扫描。
    if ((docMathElements.get(doc) ?? []).length === 0) {
      for (const element of [
        ...doc.querySelectorAll<HTMLElement>(`.${MANAGER_RENDER_CLASS}`),
      ]) {
        element.remove();
      }
      continue;
    }

    for (const annotation of annotations) {
      const position = getPDFPosition(annotation);
      const content = parseAnnotationMath(annotation);
      const rect = position?.rects?.[0];
      if (!content || !position || !rect) {
        continue;
      }

      const page = findPageElement(doc, position.pageIndex);
      if (!page) {
        continue;
      }

      const viewportRect = getViewportRect(
        runtime,
        doc,
        position.pageIndex,
        rect,
      );
      if (!viewportRect) {
        continue;
      }

      const overlay = getPageOverlay(doc, page);
      const element = getManagerOverlayElement(doc, overlay, annotation);
      renderManagerOverlayElement(
        runtime,
        element,
        annotation,
        content,
        viewportRect,
      );
      rendered += 1;
    }

    for (const element of [
      ...doc.querySelectorAll<HTMLElement>(`.${MANAGER_RENDER_CLASS}`),
    ]) {
      const annotationID = element.dataset.annotationId;
      if (annotationID && !activeIDs.has(annotationID)) {
        element.remove();
      }
    }
  }

  return rendered;
}

function getPageOverlay(doc: Document, page: HTMLElement): HTMLElement {
  let overlay = page.querySelector<HTMLElement>(
    `:scope > .${PAGE_OVERLAY_CLASS}`,
  );
  if (overlay) {
    return overlay;
  }

  overlay = doc.createElement("div");
  overlay.className = PAGE_OVERLAY_CLASS;
  page.appendChild(overlay);

  const computedStyle = doc.defaultView?.getComputedStyle(page);
  if (computedStyle?.position === "static") {
    page.style.position = "relative";
  }

  return overlay;
}

function getManagerOverlayElement(
  doc: Document,
  overlay: HTMLElement,
  annotation: _ZoteroTypes.Reader.Annotation,
): HTMLElement {
  const escapedID = escapeCSSAttributeValue(annotation.id);
  let element = overlay.querySelector<HTMLElement>(
    `:scope > .${MANAGER_RENDER_CLASS}[data-annotation-id="${escapedID}"]`,
  );
  if (element) {
    return element;
  }

  element = doc.createElement("div");
  element.className = MANAGER_RENDER_CLASS;
  element.dataset.annotationId = annotation.id;
  overlay.appendChild(element);
  return element;
}

function renderManagerOverlayElement(
  runtime: ReaderRuntime,
  element: HTMLElement,
  annotation: _ZoteroTypes.Reader.Annotation,
  content: MathContent,
  rect: ViewportRect,
): void {
  const source = getMathContent(annotation).trim();
  // 纯公式（没有普通文本）继续走旧公式的 fit-content 路径：KaTeX 天然尺寸
  // 缩放填满 rect，避免宽公式在 rich 布局里横向溢出。只有文本+公式混排
  // 才走 rich 布局。
  const formula = getSingleFormula(content);
  const isRichLayout = !formula;
  const shape = formula ? "formula" : "rich";
  const fontSize = getAnnotationFontSize(annotation);
  const previousSource = element.dataset.mathSource;
  const previousKind = element.dataset.mathKind;
  const previousShape = element.dataset.mathShape;

  setStyleIfChanged(element, "left", `${rect.left}px`);
  setStyleIfChanged(element, "top", `${rect.top}px`);
  setStyleIfChanged(element, "width", `${Math.max(rect.width, 24)}px`);
  setStyleIfChanged(element, "height", `${Math.max(rect.height, 18)}px`);
  setStyleIfChanged(element, "color", annotation.color || "#111111");
  toggleClassIfChanged(element, "is-rich", isRichLayout);
  toggleClassIfChanged(element, "is-display", formula?.mode === "display");
  setDatasetIfChanged(element, "mathMode", formula ? formula.mode : "rich");
  setDatasetIfChanged(element, "mathSource", source);
  setDatasetIfChanged(element, "mathKind", content.kind);
  setDatasetIfChanged(element, "mathShape", shape);

  if (
    previousSource !== source ||
    previousKind !== content.kind ||
    previousShape !== shape ||
    !element.firstElementChild
  ) {
    element.innerHTML = formula
      ? `<span class="${FIT_CONTENT_CLASS}">${renderLatex(
          formula.latex,
          formula.mode,
        )}</span>`
      : `<div class="${RICH_CONTENT_CLASS}">${renderRichContentHtml(
          content,
        )}</div>`;
  }

  if (formula) {
    fitFormulaToOverlay(element, rect);
  } else {
    fitRichContentToOverlay(runtime, element, rect, fontSize);
  }
  // Editing is handled by the document-level double-click handler
  // (installRenderedFormulaDblClickHandler); this element has
  // pointer-events: none, so no element-level listener would ever fire.
}

/**
 * 混合内容按"基准字号 + PDF 宽度"排版，再整体按当前缩放 transform。
 * 正常插件路径下 rect 高度就是量出来的高度，scale 恰好等于缩放；只有
 * 侧栏改内容导致高度超出 rect 时才整体缩小兜底。
 */
function fitRichContentToOverlay(
  runtime: ReaderRuntime,
  element: HTMLElement,
  rect: ViewportRect,
  fontSize: number,
): void {
  const content = element.querySelector<HTMLElement>(
    `:scope > .${RICH_CONTENT_CLASS}`,
  );
  if (!content) {
    return;
  }

  const zoom = rect.scale ?? getCurrentScale(runtime) ?? 1;
  // 保存时宽度取整（Math.ceil），这里也取整回去，避免 rect 换算的浮点误差
  // 让换行位置/高缓存键在每次渲染时抖动。
  const baseWidth = Math.max(Math.round(rect.width / Math.max(zoom, 0.01)), 1);
  const naturalHeight = measureRichContentHeight(content, baseWidth, fontSize);
  if (!naturalHeight) {
    return;
  }

  let scale = zoom;
  const availableHeight = Math.max(rect.height, 1);
  if (naturalHeight * scale > availableHeight) {
    scale = availableHeight / naturalHeight;
  }
  scale = clamp(scale, 0.1, 12);

  setStyleIfChanged(content, "width", `${baseWidth}px`);
  setStyleIfChanged(content, "font-size", `${fontSize}px`);
  setStyleIfChanged(content, "line-height", `${RICH_LINE_HEIGHT}`);
  setStyleIfChanged(content, "transform-origin", "left top");
  setStyleIfChanged(content, "transform", `scale(${scale})`);
  setStyleIfChanged(content, "left", "0px");
  setStyleIfChanged(content, "top", "0px");
}

function measureRichContentHeight(
  content: HTMLElement,
  width: number,
  fontSize: number,
): number | undefined {
  const ownerDoc = content.ownerDocument;
  const fontsReady =
    !ownerDoc || !ownerDoc.fonts || ownerDoc.fonts.status === "loaded";
  const cached = state.richContentSizeCache.get(content);
  if (
    cached &&
    fontsReady &&
    cached.width === width &&
    cached.fontSize === fontSize
  ) {
    return cached.height;
  }

  content.style.width = `${width}px`;
  content.style.fontSize = `${fontSize}px`;
  content.style.lineHeight = `${RICH_LINE_HEIGHT}`;
  content.style.transform = "";
  const height = content.offsetHeight;
  if (!height) {
    return undefined;
  }
  if (fontsReady) {
    state.richContentSizeCache.set(content, { width, height, fontSize });
  }
  return height;
}

function fitFormulaToOverlay(element: HTMLElement, rect: ViewportRect): void {
  const content = element.querySelector<HTMLElement>(
    `:scope > .${FIT_CONTENT_CLASS}`,
  );
  if (!content) {
    return;
  }

  const size = measureFitContent(content);
  if (!size) {
    return;
  }

  const scale = clamp(
    Math.min(
      Math.max(rect.width, 1) / size.width,
      Math.max(rect.height, 1) / size.height,
    ),
    0.1,
    12,
  );
  const left = Math.max(0, (rect.width - size.width * scale) / 2);
  const top = Math.max(0, (rect.height - size.height * scale) / 2);

  content.style.transformOrigin = "left top";
  content.style.transform = `scale(${scale})`;
  content.style.left = `${left}px`;
  content.style.top = `${top}px`;
}

/**
 * 测量 fit-content span 的天然尺寸，按元素缓存。
 *
 * overlay 内部的 `<span class="fit-content">` 只在 LaTeX 源或模式变化时被
 * 整体替换（`renderManagerOverlayElement` 重写 innerHTML），所以它的排版尺寸
 * 在每次标注层 DOM 变化触发的稳态重定位渲染里是稳定的。按该 span 元素缓存
 * 测量结果，可跳过每次重定位时的 `getBoundingClientRect` 强制布局读。
 *
 * 缓存只在 `document.fonts` 为 loaded 后才启用：KaTeX 字形指标在字体就绪前后
 * 会变化，过早的测量不能固化成缓存；字体未就绪时回退到每次重测（原行为）。
 */
function measureFitContent(
  content: HTMLElement,
): { width: number; height: number } | undefined {
  const ownerDoc = content.ownerDocument;
  const fontsReady =
    !ownerDoc || !ownerDoc.fonts || ownerDoc.fonts.status === "loaded";
  const cached = state.formulaContentSizeCache.get(content);
  if (cached && fontsReady) {
    return cached;
  }

  content.style.position = "absolute";
  content.style.transform = "";
  content.style.left = "0";
  content.style.top = "0";

  const contentRect = content.getBoundingClientRect();
  if (!contentRect.width || !contentRect.height) {
    return undefined;
  }

  const size = { width: contentRect.width, height: contentRect.height };
  if (fontsReady) {
    state.formulaContentSizeCache.set(content, size);
  }
  return size;
}
