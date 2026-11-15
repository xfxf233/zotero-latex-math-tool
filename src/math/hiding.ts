/**
 * 隐藏页面上的原始数学源码（pdf.js 的 textarea/input 控件），并在内容不再是数学标注时
 * 恢复显示。匹配以 data-id 优先、value 回退。
 */
import {
  getManagerAnnotationCount,
  getMathAnnotations,
  getMathContent,
  readerHasMath,
} from "./annotationData";
import {
  EDITOR_FRAME_CLASS,
  MANAGER_RENDER_CLASS,
  PAGE_OVERLAY_CLASS,
  RAW_HIDDEN_CLASS,
} from "./constants";
import { getTextFieldValue } from "./dom";
import { collectReaderDocuments } from "./readerDocs";
import { state } from "./state";
import type { ReaderRuntime } from "./types";

/**
 * 是否有"残留隐藏"的原文控件：控件带 RAW_HIDDEN_CLASS 但其 value 已不含
 * 数学内容（例如侧栏把数学标注改成了普通文本）。此时若不补一次渲染，隐藏
 * 类会让普通文本保持透明不可见，直到下一次翻页/缩放。仅在标注编辑路径调用。
 */
export function hasStaleRawHiddenControls(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
): boolean {
  const { sources, ids } = getMathControlSets(reader);
  for (const doc of collectReaderDocuments(reader)) {
    for (const element of doc.querySelectorAll<HTMLElement>(
      `.${RAW_HIDDEN_CLASS}`,
    )) {
      if (!isMathControl(element, sources, ids)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Hide freshly-inserted raw math text before the next paint, without waiting
 * for the debounced render pass.
 *
 * pdf.js rebuilds the annotation layer (re-creating the `textarea` controls
 * that hold the raw `[[math:…]]` text) on zoom and re-render. Those new
 * controls lack the hidden class, and the 50ms debounce keeps getting reset
 * during a continuous zoom, so the raw text would otherwise stay visible for
 * the whole gesture. The MutationObserver fires before paint, so hiding the
 * added controls here removes the flash. Only the mutation's added nodes are
 * inspected — no full-document scan.
 */
export function hideNewRawMathText(
  runtime: ReaderRuntime,
  mutations: MutationRecord[],
): void {
  if (!readerHasMath(runtime.reader)) {
    return;
  }
  const { sources, ids } = getMathControlSets(runtime.reader);
  for (const mutation of mutations) {
    if (mutation.type !== "childList") {
      continue;
    }
    for (const node of mutation.addedNodes) {
      if (node && node.nodeType === 1) {
        hideMathTextFields(node as Element, sources, ids);
      }
    }
  }
}

function hideMathTextFields(
  root: Element,
  sources: Set<string>,
  ids: Set<string>,
): void {
  const tag = root.localName.toLowerCase();
  if (tag === "textarea" || tag === "input") {
    hideMathTextField(root as HTMLElement, sources, ids);
    return;
  }
  for (const field of root.querySelectorAll<HTMLElement>("textarea,input")) {
    hideMathTextField(field, sources, ids);
  }
}

function hideMathTextField(
  field: HTMLElement,
  sources: Set<string>,
  ids: Set<string>,
): void {
  if (
    field.classList.contains(RAW_HIDDEN_CLASS) ||
    shouldSkipRawHide(field) ||
    !isMathControl(field, sources, ids)
  ) {
    return;
  }
  field.classList.add(RAW_HIDDEN_CLASS);
  field.setAttribute("aria-hidden", "true");
}

/**
 * 数学标注的正文集合 + id 集合。observer 的 hideNewRawMathText 只拿到
 * 控件节点，用 data-id 精确匹配（真机确认 id 在 `data-id`）；拿不到 id 时
 * 才退回 value 匹配。数量变化自动重建；comment 内容变化由编辑入口显式失效。
 */
export function getMathControlSets(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
): {
  sources: Set<string>;
  ids: Set<string>;
} {
  const count = getManagerAnnotationCount(reader);
  const cached = state.mathControlCache.get(reader);
  if (cached && cached.count === count) {
    return cached;
  }

  const sources = new Set<string>();
  const ids = new Set<string>();
  for (const annotation of getMathAnnotations(reader)) {
    ids.add(annotation.id);
    const source = getMathContent(annotation).trim();
    if (source) {
      sources.add(source);
    }
  }
  const sets = { count, sources, ids };
  state.mathControlCache.set(reader, sets);
  return sets;
}

function getAnnotationControlId(element: Element): string | undefined {
  const id = (element as HTMLElement).dataset?.id;
  return id || undefined;
}

/**
 * 是否是一条数学标注对应的原文控件。有 data-id 时以 id 为准（防止原生标注
 * 恰好与某条数学标注正文相同时被误隐藏）；没有 data-id 才退回 value 匹配。
 */
function isMathControl(
  element: Element,
  sources: Set<string>,
  ids: Set<string>,
): boolean {
  const value = getTextFieldValue(element);
  if (!value) {
    return false;
  }
  const id = getAnnotationControlId(element);
  return id ? ids.has(id) : sources.has(value.trim());
}

export function getElementsWithMathText(
  doc: Document,
  sources: Set<string>,
  ids: Set<string>,
): HTMLElement[] {
  // The raw math source always lives in a free-text annotation control
  // (Zotero renders text annotations as
  //   <textarea class="textAnnotation" data-id="<annotationID>">…</textarea>
  // with the annotation comment in the control's value; confirmed on-device).
  // Scan only those controls — a full-document TreeWalker over every text
  // node in the viewer was a hot-path cost on each render pass.
  // Match by data-id when present; fall back to value matching only when the
  // control has no id. Untagged native text annotations are never touched.
  const elements = new Set<HTMLElement>();
  for (const field of [
    ...doc.querySelectorAll<HTMLElement>("textarea,input"),
  ]) {
    if (isMathControl(field, sources, ids)) {
      elements.add(field);
    }
  }
  return [...elements];
}

export function hideRawMathElements(
  doc: Document,
  mathElements: HTMLElement[],
  sources: Set<string>,
  ids: Set<string>,
): void {
  // mathElements 是 renderMathAnnotations 为本 doc 预扫描的数学控件集合，
  // 与 hideRawMathElements 自行扫描 getElementsWithMathText(doc, sources, ids)
  // 的结果一致（两次调用之间没有会影响控件 value 的 DOM 变更），行为完全等价。
  const activeElements = new Set(mathElements);

  for (const element of [
    ...doc.querySelectorAll<HTMLElement>(`.${RAW_HIDDEN_CLASS}`),
  ]) {
    if (!activeElements.has(element) || !isMathControl(element, sources, ids)) {
      element.classList.remove(RAW_HIDDEN_CLASS);
      element.removeAttribute("aria-hidden");
    }
  }

  for (const element of activeElements) {
    if (shouldSkipRawHide(element)) {
      continue;
    }
    element.classList.add(RAW_HIDDEN_CLASS);
    element.setAttribute("aria-hidden", "true");
  }
}

function shouldSkipRawHide(element: HTMLElement): boolean {
  if (
    element.closest(`.${MANAGER_RENDER_CLASS}`) ||
    element.closest(`.${PAGE_OVERLAY_CLASS}`) ||
    element.closest(".zotero-latex-math-modal") ||
    element.closest(`.${EDITOR_FRAME_CLASS}`)
  ) {
    return true;
  }

  return Boolean(
    element.matches(
      "html,body,#viewer,#viewerContainer,.page,.annotationLayer,.annotationEditorLayer",
    ),
  );
}
