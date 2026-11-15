/**
 * development 构建才启用的诊断日志（production 构建会被 `__env__` 短路）。
 *
 * 用于在真机核对 Zotero 内部结构/调用时序；诊断失败绝不能影响主流程。
 */
import {
  getAnnotationManager,
  getMathAnnotations,
  getMathContent,
  getPDFPosition,
} from "./annotationData";
import { MANAGER_RENDER_CLASS } from "./constants";
import { getSourceText } from "./dom";
import { getCurrentScale } from "./geometry";
import { getElementsWithMathText, getMathControlSets } from "./hiding";
import { logError } from "./log";
import { getRuntimeDocuments } from "./readerDocs";
import { state } from "./state";
import {
  findLastAnnotationToolButton,
  getButtonLabel,
  isFreeTextToolLabel,
} from "./toolbarLabels";
import type { AnnotationManager, ReaderRuntime } from "./types";

/**
 * dev-only：记录工具栏按钮定位的真实结果，用于确认 Σ 按钮找"文字工具"
 * 按钮的方式（标签正则 vs fallback）是否与真机工具栏结构吻合。
 */
export function logToolbarPlacementDiagnostics(
  nativeButtons: HTMLElement[],
): void {
  try {
    const candidates = nativeButtons.slice(0, 15).map((candidate) => ({
      tag: candidate.localName,
      label: getButtonLabel(candidate).slice(0, 48) || "(empty)",
      isFreeTextMatch: isFreeTextToolLabel(getButtonLabel(candidate)),
    }));
    const textButton = nativeButtons.find((candidate) =>
      isFreeTextToolLabel(getButtonLabel(candidate)),
    );
    const fallbackButton = textButton
      ? undefined
      : findLastAnnotationToolButton(nativeButtons);
    Zotero.debug(
      `[LaTeX Math Tool] toolbar placement ${JSON.stringify({
        buttonCount: nativeButtons.length,
        matchedByFreeTextLabel: Boolean(textButton),
        fallbackToLastAnnotationTool: Boolean(fallbackButton),
        matchedLabel: textButton ? getButtonLabel(textButton).slice(0, 48) : "",
        candidates,
      })}`,
    );
  } catch (error) {
    logError("Unable to log toolbar placement", error);
  }
}

export function logRenderDiagnostics(
  runtime: ReaderRuntime,
  stats: {
    docCount: number;
    overlayCount: number;
  },
): void {
  // Diagnostics walk every text node in the viewer; never run them in
  // production, where they would be pure overhead on every render pass.
  if (__env__ !== "development") {
    return;
  }

  const mathAnnotations = getMathAnnotations(runtime.reader);
  if (!mathAnnotations.length) {
    return;
  }

  const docs = getRuntimeDocuments(runtime);
  const { sources, ids } = getMathControlSets(runtime.reader);
  const summary = {
    ...stats,
    mathAnnotationCount: mathAnnotations.length,
    scale: getCurrentScale(runtime),
    // 真机确认 `_annotations` / `_unsavedAnnotations` 的实际容器类型、
    // setAnnotations/updateAnnotations 补丁是否真的被调用。
    managerCollections: describeManagerCollections(runtime.reader),
    pageLabels: describePageLabels(runtime),
    annotations: mathAnnotations.slice(0, 5).map((annotation) => ({
      id: annotation.id,
      pageIndex: getPDFPosition(annotation)?.pageIndex,
      // sortIndex / pageLabel 是插件拼写/读取的两个猜测点：和侧栏实际
      // 排序、页码标签对比即可确认格式是否正确。
      sortIndex: annotation.sortIndex,
      pageLabel: annotation.pageLabel,
      rectsCount: getPDFPosition(annotation)?.rects?.length ?? 0,
      rect: getPDFPosition(annotation)?.rects?.[0],
      text: (annotation.text ?? "").slice(0, 64),
      comment: (annotation.comment ?? "").slice(0, 64),
      textPrefix: getMathContent(annotation).slice(0, 32),
    })),
    docs: docs.map((doc, index) => {
      const mathElements = getElementsWithMathText(doc, sources, ids);
      return {
        index,
        url: doc.location?.href,
        pages: doc.querySelectorAll(".page").length,
        annotationLayers: doc.querySelectorAll(".annotationLayer").length,
        editorLayers: doc.querySelectorAll(".annotationEditorLayer").length,
        mathTextNodes: mathElements.length,
        managerOverlays: doc.querySelectorAll(`.${MANAGER_RENDER_CLASS}`)
          .length,
        sampleMathElements: mathElements
          .slice(0, 3)
          .map((element) => describeElement(element)),
      };
    }),
  };
  const signature = JSON.stringify(summary);
  if (state.lastRenderDiagnostics.get(runtime.reader) === signature) {
    return;
  }

  state.lastRenderDiagnostics.set(runtime.reader, signature);
  Zotero.debug(`[LaTeX Math Tool] render diagnostics ${signature}`);
}

function describeElement(element: HTMLElement): Record<string, string> {
  return {
    tag: element.localName,
    id: element.id,
    class: element.className,
    dataAnnotationId: element.dataset.annotationId ?? "",
    dataAnnotationKey: element.dataset.annotationKey ?? "",
    dataID: element.dataset.id ?? "",
    dataEditorID: element.dataset.editorId ?? "",
    text: getSourceText(element).slice(0, 80),
  };
}

/** dev-only：确认 manager 内部标注容器的真实类型（array / Set / 其他）。 */
function describeManagerCollections(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
): {
  annotationsType: string;
  unsavedAnnotationsType: string;
  setAnnotationsCalls: number;
  updateAnnotationsCalls: number;
} {
  try {
    const manager = getAnnotationManager(reader) as unknown as {
      _annotations?: unknown;
      _unsavedAnnotations?: unknown;
    };
    return {
      annotationsType: describeListType(manager?._annotations),
      unsavedAnnotationsType: describeListType(manager?._unsavedAnnotations),
      setAnnotationsCalls: state.setAnnotationsCalls.get(reader) ?? 0,
      updateAnnotationsCalls: state.updateAnnotationsCalls.get(reader) ?? 0,
    };
  } catch (error) {
    logError("Unable to inspect manager collections", error);
    return {
      annotationsType: "error",
      unsavedAnnotationsType: "error",
      setAnnotationsCalls: 0,
      updateAnnotationsCalls: 0,
    };
  }
}

/** dev-only：确认 pdf.js 内部 `_pageLabels` 是否存在、内容是否正确。 */
function describePageLabels(runtime: ReaderRuntime): Record<string, unknown> {
  try {
    const app = (runtime.win as any)?.PDFViewerApplication;
    const labels = app?.pdfViewer?._pageLabels;
    return {
      present: Array.isArray(labels),
      length: Array.isArray(labels) ? labels.length : undefined,
      sample: Array.isArray(labels) ? labels.slice(0, 5) : undefined,
    };
  } catch (error) {
    logError("Unable to inspect page labels", error);
    return { present: false };
  }
}

/** 返回容器类型的可读描述，跨 realm 也用 toStringTag 兜底。 */
function describeListType(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return Object.prototype.toString.call(value);
}

/**
 * Dev-only diagnostics for the native `addAnnotation` creation path.
 * Verifies Zotero generated the id/defaults, that the annotation is in
 * `_annotations`, and whether `_save` is required for persistence.
 */
export function logCreateDiagnostics(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  manager: AnnotationManager,
  info: {
    // 传入 addAnnotation 的克隆对象（partial 类型，仅用于身份比较）
    annotation: unknown;
    created: _ZoteroTypes.Reader.Annotation;
    beforeLength: number;
    phase: "pre-save" | "post-save";
  },
): void {
  if (__env__ !== "development") {
    return;
  }
  // 诊断绝不能影响创建流程：任何字段访问异常都吞掉，不抛回创建路径。
  try {
    const { annotation, created, beforeLength, phase } = info;
    // _unsavedAnnotations 真机为 Map（早前真机报错曾猜测为 Set、未证实），不是
    // 数组，不能直接 .some()。按数组 / 有 .has() 的容器（Map/Set）处理，拿不到就留空。
    const unsaved: unknown = manager._unsavedAnnotations;
    let unsavedQueued: boolean | undefined;
    if (Array.isArray(unsaved)) {
      unsavedQueued = unsaved.some((candidate) => candidate.id === created.id);
    } else if (
      unsaved &&
      typeof (unsaved as { has?: unknown }).has === "function"
    ) {
      // Map 的 key 可能是 annotation 对象也可能是 id，两种都查；对 Set 也安全。
      const container = unsaved as { has: (key: unknown) => boolean };
      unsavedQueued = container.has(created) || container.has(created.id);
    }
    const summary = {
      phase,
      returnedId: created.id,
      sameObject: created === annotation,
      type: created.type,
      color: created.color,
      sortIndex: created.sortIndex,
      pageLabel: created.pageLabel,
      text: (created.text ?? "").slice(0, 64),
      comment: (created.comment ?? "").slice(0, 80),
      position: getPDFPosition(created),
      dateCreated: created.dateCreated,
      dateModified: created.dateModified,
      authorName: created.authorName,
      isAuthorNameAuthoritative: created.isAuthorNameAuthoritative,
      tags: created.tags,
      annotationsBefore: beforeLength,
      annotationsAfter: manager._annotations.length,
      inAnnotations: manager._annotations.some(
        (candidate) => candidate.id === created.id,
      ),
      runtimeExists: state.runtimes.has(reader),
      mathAnnotationsCount: getMathAnnotations(reader).length,
      unsavedQueued,
    };
    Zotero.debug(`[LaTeX Math Tool] addAnnotation ${JSON.stringify(summary)}`);
  } catch (error) {
    logError("Unable to log addAnnotation diagnostics", error);
  }
}
