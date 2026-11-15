/**
 * 坐标系换算：PDF 单位 rect ↔ 当前页 viewport 的 CSS 像素，以及页码、缩放、点击位置。
 *
 * 在 reader 文档里测量必须带 layoutScale（PDF 单位 × viewport scale），见
 * docs/constraints.md。
 */
import type {
  ClickLocation,
  FormulaSize,
  ReaderRuntime,
  Viewport,
  ViewportRect,
} from "./types";
import { normalizeRect, toPlainNumberArray } from "./util";

export function getCurrentScale(runtime: ReaderRuntime): number | undefined {
  const app = (runtime.win as any)?.PDFViewerApplication;
  if (app?.pdfViewer?.currentScale !== undefined) {
    return app.pdfViewer.currentScale;
  }
  return app?.pdfViewer?.getPageView?.(0)?.viewport?.scale;
}

export function findPageElement(
  doc: Document,
  pageIndex: number,
): HTMLElement | undefined {
  return (
    doc.querySelector<HTMLElement>(
      `.page[data-page-number="${pageIndex + 1}"]`,
    ) ??
    [...doc.querySelectorAll<HTMLElement>(".page")][pageIndex] ??
    undefined
  );
}

export function getViewportRect(
  runtime: ReaderRuntime,
  doc: Document,
  pageIndex: number,
  rect: number[],
): ViewportRect | undefined {
  const win = doc.defaultView ?? runtime.win;
  const viewport =
    getPDFViewportFromWindow(win, pageIndex) ??
    getPDFViewport(runtime, pageIndex);
  const viewportRect =
    viewport?.convertToViewportRectangle && win
      ? toPlainNumberArray(
          viewport.convertToViewportRectangle(
            cloneNumberArrayIntoWindow(rect, win),
          ),
        )
      : rect;
  if (viewportRect.length < 4) {
    return undefined;
  }

  const left = Math.min(viewportRect[0], viewportRect[2]);
  const top = Math.min(viewportRect[1], viewportRect[3]);
  const right = Math.max(viewportRect[0], viewportRect[2]);
  const bottom = Math.max(viewportRect[1], viewportRect[3]);
  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
    scale:
      typeof viewport?.scale === "number" && viewport.scale > 0
        ? viewport.scale
        : undefined,
  };
}

export function getDocZoom(
  doc: Document,
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  pageIndex: number,
): number {
  const viewport =
    getPDFViewportFromWindow(doc.defaultView, pageIndex) ??
    getPDFViewportFromReader(reader, pageIndex);
  const scale = viewport?.scale;
  return typeof scale === "number" && scale > 0 ? scale : 1;
}

export function getClickLocationFromDocument(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  doc: Document,
  event: MouseEvent,
): ClickLocation | undefined {
  const target = event.target as Element | null;
  // The click must land on an actual `.page` element. The toolbar lives in
  // the same document as the pages, so without this requirement a toolbar
  // click (e.g. on the Σ button while math insert mode is armed) would fall
  // through to the first `.page` and wrongly open the editor.
  const page =
    (target?.closest(".page") as HTMLElement | null | undefined) ??
    (doc.elementFromPoint(event.clientX, event.clientY)?.closest(".page") as
      HTMLElement | null | undefined);
  if (!page) {
    return undefined;
  }

  const pageIndex = getPageIndex(doc, page);
  const width = 220;
  const height = 48;
  const viewport =
    getPDFViewportFromWindow(doc.defaultView, pageIndex) ??
    getPDFViewportFromReader(reader, pageIndex);
  const point = getViewportPoint(page, event.clientX, event.clientY, viewport);
  const x = Math.max(0, point.x);
  const y = Math.max(0, point.y);

  if (viewport?.convertToPdfPoint) {
    const start = toPlainNumberArray(viewport.convertToPdfPoint(x, y));
    const end = toPlainNumberArray(
      viewport.convertToPdfPoint(x + width, y + height),
    );
    return {
      pageIndex,
      rect: normalizeRect([start[0], start[1], end[0], end[1]]),
    };
  }

  return { pageIndex, rect: [x, y, x + width, y + height] };
}

export function getPageIndex(doc: Document, page: HTMLElement): number {
  const pageNumber = Number(page.dataset.pageNumber);
  if (Number.isFinite(pageNumber) && pageNumber > 0) {
    return pageNumber - 1;
  }
  return [...doc.querySelectorAll<HTMLElement>(".page")].indexOf(page);
}

export function getPDFViewport(
  runtime: ReaderRuntime,
  pageIndex: number,
): Viewport | undefined {
  return getPDFViewportFromWindow(runtime.win, pageIndex);
}

function getPDFViewportFromReader(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  pageIndex: number,
): Viewport | undefined {
  const internalReader = reader._internalReader as any;
  for (const view of [
    internalReader?._primaryView,
    internalReader?._secondaryView,
    internalReader?._lastView,
  ]) {
    const viewport = getPDFViewportFromWindow(
      view?._iframeWindow ?? view?._iframe?.contentWindow,
      pageIndex,
    );
    if (viewport) {
      return viewport;
    }
  }
  return undefined;
}

export function getPageLabel(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  pageIndex: number,
  doc?: Document,
): string {
  const internalReader = reader._internalReader as any;
  const windows = [
    doc?.defaultView,
    internalReader?._primaryView?._iframeWindow,
    internalReader?._secondaryView?._iframeWindow,
    internalReader?._lastView?._iframeWindow,
  ];
  for (const win of windows) {
    const label = (win as any)?.PDFViewerApplication?.pdfViewer?._pageLabels?.[
      pageIndex
    ];
    if (label !== undefined && label !== null && String(label).length) {
      return String(label);
    }
  }
  return String(pageIndex + 1);
}

export function getPDFViewportFromWindow(
  win: Window | null,
  pageIndex: number,
): Viewport | undefined {
  const app = (win as any)?.PDFViewerApplication;
  return app?.pdfViewer?.getPageView?.(pageIndex)?.viewport;
}

export function getViewportPoint(
  page: HTMLElement,
  clientX: number,
  clientY: number,
  viewport?: Viewport,
): { x: number; y: number } {
  // PDF.js pages can include a transparent border outside viewport (0, 0).
  const surface =
    page.querySelector<HTMLElement>(":scope > .canvasWrapper") ??
    page.querySelector<HTMLElement>(".canvasWrapper") ??
    page.querySelector<HTMLElement>("canvas");
  const surfaceRect = surface?.getBoundingClientRect();
  const pageRect = page.getBoundingClientRect();
  const left = surfaceRect?.width
    ? surfaceRect.left
    : pageRect.left + page.clientLeft;
  const top = surfaceRect?.height
    ? surfaceRect.top
    : pageRect.top + page.clientTop;
  const renderedWidth = surfaceRect?.width || page.clientWidth;
  const renderedHeight = surfaceRect?.height || page.clientHeight;
  const scaleX =
    viewport?.width && renderedWidth ? viewport.width / renderedWidth : 1;
  const scaleY =
    viewport?.height && renderedHeight ? viewport.height / renderedHeight : 1;

  return {
    x: (clientX - left) * scaleX,
    y: (clientY - top) * scaleY,
  };
}

export function resizeLocationRect(
  doc: Document,
  location: ClickLocation,
  size: FormulaSize,
  reader?: _ZoteroTypes.ReaderInstance<"pdf">,
): number[] {
  const viewport =
    getPDFViewportFromWindow(doc.defaultView, location.pageIndex) ??
    (reader ? getPDFViewportFromReader(reader, location.pageIndex) : undefined);
  const win = doc.defaultView;
  if (
    !win ||
    !viewport?.convertToViewportRectangle ||
    !viewport.convertToPdfPoint
  ) {
    return [
      location.rect[0],
      location.rect[1],
      location.rect[0] + size.width,
      location.rect[1] + size.height,
    ];
  }

  const viewportRect = toPlainNumberArray(
    viewport.convertToViewportRectangle(
      cloneNumberArrayIntoWindow(location.rect, win),
    ),
  );
  const left = Math.min(viewportRect[0], viewportRect[2]);
  const top = Math.min(viewportRect[1], viewportRect[3]);
  const start = toPlainNumberArray(viewport.convertToPdfPoint(left, top));
  const end = toPlainNumberArray(
    viewport.convertToPdfPoint(left + size.width, top + size.height),
  );
  return normalizeRect([start[0], start[1], end[0], end[1]]);
}

function cloneNumberArrayIntoWindow(values: number[], win: Window): number[] {
  const plainValues = values.map((value) => Number(value));
  try {
    return Components.utils.cloneInto(plainValues, win) as number[];
  } catch {
    return plainValues;
  }
}

export function createSortIndex(location: ClickLocation): string {
  const x = Math.round(location.rect[0]);
  const y = Math.round(location.rect[1]);
  return [
    location.pageIndex.toString().padStart(5, "0"),
    formatSortIndexCoordinate(y, 6),
    formatSortIndexCoordinate(x, 5),
  ].join("|");
}

function formatSortIndexCoordinate(value: number, width: number): string {
  const sign = value < 0 ? "-" : "";
  const absValue = Math.abs(value)
    .toString()
    .padStart(width - sign.length, "0");
  return `${sign}${absValue}`;
}
