/**
 * 内容尺寸测量：按 overlay 同款 CSS 量出 PDF 单位宽高，并按测量结果写回标注 rect。
 *
 * 只在保存/编辑/拖动时调用，不在渲染热路径上。
 */
import { getSingleFormula, legacyToRichSource } from "../richText/layout";
import { parseMathContent } from "../richText/parse";
import type { MathMode } from "../richText/parse";
import { getPDFPosition } from "./annotationData";
import {
  FIT_CONTENT_CLASS,
  RICH_LINE_HEIGHT,
  RICH_MAX_WIDTH,
  RICH_MEASURE_CLASS,
  RICH_TEXT_MAX_WIDTH,
} from "./constants";
import { getDocZoom, resizeLocationRect } from "./geometry";
import { renderLatex, renderRichContentHtml } from "./katex";
import { cloneIntoManagerRealm } from "./realm";
import { injectStyles } from "./styles";
import type { AnnotationManager, ClickLocation, FormulaSize } from "./types";
import { clamp } from "./util";

export function getRichAnnotationRect(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  doc: Document | undefined,
  location: ClickLocation,
  source: string,
  baseFontSize: number,
  renderedSize?: FormulaSize,
): number[] {
  if (!doc) {
    return location.rect;
  }

  const zoom = getDocZoom(doc, reader, location.pageIndex);
  const size =
    renderedSize ??
    measureRichSource(doc, source, baseFontSize, {
      layoutScale: zoom,
    });
  if (!size) {
    return location.rect;
  }

  return resizeLocationRect(
    doc,
    location,
    { width: size.width * zoom, height: size.height * zoom },
    reader,
  );
}

/**
 * 按基准字号测量内容在 PDF 单位下的自然宽高。
 *
 * 与 overlay 共用同一套 CSS/字体；测量只在保存/编辑时发生，不在渲染热路径。
 * 纯公式按 overlay 的 fit-content 渲染量（而不是 rich 容器），否则 rich 容器的
 * 行高 / 块级公式上下边距会把 rect 撑高，框看起来比公式大一圈。含普通文本的
 * 内容默认按 320pt 换行；编辑已有标注时传入它当前的 `width`，保留用户手动拉宽
 * 的宽度，只重算高度。
 */
export function measureRichSource(
  doc: Document,
  source: string,
  fontSize: number,
  options: { width?: number; layoutScale?: number } = {},
): FormulaSize | undefined {
  const layoutScale =
    options.layoutScale && options.layoutScale > 0 ? options.layoutScale : 1;
  const content = parseMathContent(source);
  if (!content) {
    return undefined;
  }
  if (content.kind === "legacy") {
    return measureRichSource(
      doc,
      legacyToRichSource(content),
      fontSize,
      options,
    );
  }

  const formula = getSingleFormula(content);
  if (formula) {
    return measureFormulaSource(
      doc,
      formula.latex,
      formula.mode,
      fontSize,
      options.width,
      layoutScale,
    );
  }

  injectStyles(doc);
  const body = doc.body;
  if (!body) {
    return undefined;
  }
  const measure = doc.createElement("div");
  measure.className = RICH_MEASURE_CLASS;
  measure.style.position = "fixed";
  measure.style.left = "-10000px";
  measure.style.top = "-10000px";
  measure.style.visibility = "hidden";
  measure.style.pointerEvents = "none";
  measure.style.fontSize = `${fontSize * layoutScale}px`;
  measure.style.lineHeight = `${RICH_LINE_HEIGHT}`;
  measure.style.whiteSpace = "pre-wrap";
  measure.style.width = "max-content";
  measure.innerHTML = renderRichContentHtml(content);
  body.appendChild(measure);

  try {
    const naturalWidth = measure.getBoundingClientRect().width / layoutScale;
    const hasText = content.document.nodes.some(
      (node) => node.type === "text" && node.value.trim().length > 0,
    );
    // 最小尺寸只兜底一个字号（与 Zotero 原生文本标注的 min-width/min-height
    // 一致），不能写死 20/36：小字号（例如 7pt）的单行标注会被撑成两行高，
    // 框里留出一大块空白。
    const minSize = Math.max(Math.ceil(fontSize), 1);
    const requestedWidth = options.width;
    const maxWidth =
      requestedWidth !== undefined
        ? RICH_MAX_WIDTH
        : hasText
          ? RICH_TEXT_MAX_WIDTH
          : RICH_MAX_WIDTH;
    const width = clamp(
      requestedWidth !== undefined
        ? Math.round(requestedWidth)
        : Math.ceil(naturalWidth),
      minSize,
      maxWidth,
    );
    measure.style.width = `${width * layoutScale}px`;
    const height = measure.getBoundingClientRect().height / layoutScale;
    if (!height) {
      return undefined;
    }
    return {
      width,
      height: Math.max(Math.ceil(height), minSize),
    };
  } finally {
    measure.remove();
  }
}

/**
 * 测量纯公式在 overlay 里的真实渲染尺寸。
 *
 * 必须和 `fitFormulaToOverlay` 量到的 DOM 一致：独立的 fit-content span、
 * 块级公式的 `.katex-display` 去掉默认 1em 上下边距、`white-space: nowrap`。
 * 纯公式的 rect 按这个尺寸写回，框才会贴合公式；用 rich 容器量会把行高和
 * 块级公式的上下边距算进去，框比公式高出一大截。
 *
 * 传入 `requestedWidth`（编辑/拖动后保留当前宽度）时按该宽度等比缩放高度，
 * overlay 的 fit 缩放后仍然正好填满框。`layoutScale` 用于在 reader 文档里
 * 按当前缩放把 PDF 单位换算成 CSS px 再量（返回的仍是 PDF 单位）。
 */
function measureFormulaSource(
  doc: Document,
  latex: string,
  mode: MathMode,
  fontSize: number,
  requestedWidth?: number,
  layoutScale = 1,
): FormulaSize | undefined {
  injectStyles(doc);
  const body = doc.body;
  if (!body) {
    return undefined;
  }

  const measure = doc.createElement("span");
  measure.className = FIT_CONTENT_CLASS;
  measure.style.position = "fixed";
  measure.style.left = "-10000px";
  measure.style.top = "-10000px";
  measure.style.visibility = "hidden";
  measure.style.pointerEvents = "none";
  measure.style.fontSize = `${fontSize * layoutScale}px`;
  measure.style.lineHeight = "normal";
  measure.style.whiteSpace = "nowrap";
  measure.innerHTML = renderLatex(latex, mode);
  // 块级公式在 overlay 里由 `.zotero-latex-math-manager-render .katex-display`
  // 清零 margin；测量用的 span 不在该容器内，需要单独清零。
  for (const display of measure.querySelectorAll<HTMLElement>(
    ".katex-display",
  )) {
    display.style.margin = "0";
  }
  body.appendChild(measure);

  try {
    const rect = measure.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return undefined;
    }
    const naturalWidth = rect.width / layoutScale;
    const naturalHeight = rect.height / layoutScale;
    // 宽度上限 720pt；超出（或用户手动指定更窄/更宽）时等比缩放高度，
    // overlay 按 rect 做 fit 缩放后公式仍然正好填满框。
    const width =
      requestedWidth !== undefined
        ? clamp(Math.round(requestedWidth), 1, RICH_MAX_WIDTH)
        : Math.min(naturalWidth, RICH_MAX_WIDTH);
    const height = naturalHeight * (width / naturalWidth);
    return {
      width: Math.max(Math.ceil(width), 1),
      height: Math.max(Math.ceil(height), 1),
    };
  } finally {
    measure.remove();
  }
}

export function resizeAnnotationRect(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  manager: AnnotationManager,
  annotation: _ZoteroTypes.Reader.Annotation,
  doc: Document,
  size: FormulaSize,
): void {
  const position = getPDFPosition(annotation);
  const rect = position?.rects?.[0];
  if (!position || !rect) {
    return;
  }

  const resized = resizeLocationRect(
    doc,
    { pageIndex: position.pageIndex, rect },
    size,
    reader,
  );
  const annotationPosition = annotation.position as {
    rects?: number[][];
  };
  annotationPosition.rects = cloneIntoManagerRealm(manager, [
    resized.map((value) => Number(value)),
  ]);
}
