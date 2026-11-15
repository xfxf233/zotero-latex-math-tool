/**
 * 对 Zotero 的补丁点：包装 AnnotationManager 的标注增改入口、PDF view 的
 * adjustTextAnnotationPosition、reader.uninit。全部是包装/监听，不改 Zotero 源码。
 *
 * 补丁目的与 Zotero 内部行为见 docs/architecture.md、docs/zotero-runtime.md。
 */
import {
  getAnnotationFontSize,
  getAnnotationManager,
  getManagerAnnotations,
  getMathContent,
  getPDFPosition,
  hasMathAnnotation,
  invalidateMathAnnotationCache,
  parseAnnotationMath,
  resolveAnnotationsById,
} from "./annotationData";
import { ensureAnnotationMetadata } from "./annotations";
import { disposeRuntime } from "./dispose";
import { getDocZoom } from "./geometry";
import { hasStaleRawHiddenControls } from "./hiding";
import { captureNativeTextAnnotation } from "./insert";
import { logError } from "./log";
import { measureRichSource } from "./measure";
import { cloneIntoManagerRealm } from "./realm";
import { scheduleRender } from "./renderer";
import { state } from "./state";
import type { AdjustablePDFView, AnnotationManager } from "./types";

export function patchAnnotationManager(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  manager: AnnotationManager,
): void {
  if (state.patchedManagers.has(manager)) {
    return;
  }

  const originalAddAnnotation = manager.addAnnotation.bind(manager);
  manager.addAnnotation = ((
    annotation: Parameters<typeof manager.addAnnotation>[0],
  ) => {
    if (!state.alive) {
      return originalAddAnnotation(annotation);
    }
    const created = originalAddAnnotation(annotation);
    invalidateMathAnnotationCache(reader);
    captureNativeTextAnnotation(reader, created);
    return created;
  }) as typeof manager.addAnnotation;

  const originalUpdateAnnotations = manager.updateAnnotations?.bind(manager);
  if (originalUpdateAnnotations) {
    manager.updateAnnotations = ((
      annotations: _ZoteroTypes.Reader.Annotation[],
    ) => {
      if (!state.alive) {
        return originalUpdateAnnotations(annotations);
      }
      if (__env__ === "development") {
        state.updateAnnotationsCalls.set(
          reader,
          (state.updateAnnotationsCalls.get(reader) ?? 0) + 1,
        );
      }
      for (const annotation of annotations) {
        captureNativeTextAnnotation(reader, annotation);
      }
      invalidateMathAnnotationCache(reader);
      // 拖动边框只改 rect，不会按渲染内容重排；在交给 Zotero 合并前把宽度
      // 变化后的高度补算好，避免一行内容留在两行高的框里。
      normalizeResizedMathAnnotationRects(reader, annotations);
      const result = originalUpdateAnnotations(annotations);
      // Zotero 的 updateAnnotations 入参可能是 partial（例如侧栏只传
      // { id, comment } 或 { id, tags }）。originalUpdateAnnotations 会把它们
      // 与已有标注合并写回 _annotations，所以判定/元数据必须读合并后的完整对象。
      ensureAnnotationMetadata(reader);
      const updatedAnnotations = resolveAnnotationsById(reader, annotations);
      if (hasMathAnnotation(updatedAnnotations)) {
        scheduleRender(reader, true);
      } else if (hasStaleRawHiddenControls(reader)) {
        // 数学标注被改成普通文本：残留隐藏类会遮住文本。标记并补一次渲染
        // 来清理（渲染完成即移除标记，日常热路径检查为 O(1)）。
        state.staleRawHiddenReaders.add(reader);
        scheduleRender(reader, true);
      }
      return result;
    }) as typeof manager.updateAnnotations;
  }

  const originalSetAnnotations = manager.setAnnotations?.bind(manager);
  if (originalSetAnnotations) {
    manager.setAnnotations = (async (
      annotations: _ZoteroTypes.Reader.Annotation[],
    ) => {
      if (!state.alive) {
        return originalSetAnnotations(annotations);
      }
      if (__env__ === "development") {
        state.setAnnotationsCalls.set(
          reader,
          (state.setAnnotationsCalls.get(reader) ?? 0) + 1,
        );
      }
      const result = await originalSetAnnotations(annotations);
      for (const annotation of manager._annotations ?? annotations) {
        captureNativeTextAnnotation(reader, annotation);
      }
      invalidateMathAnnotationCache(reader);
      ensureAnnotationMetadata(reader);
      if (hasMathAnnotation(manager._annotations ?? annotations)) {
        scheduleRender(reader, true);
      }
      return result;
    }) as typeof manager.setAnnotations;
  }

  const originalSave = manager._save?.bind(manager);
  if (originalSave) {
    manager._save = ((
      annotation: _ZoteroTypes.Reader.Annotation,
      instant?: boolean,
    ) => {
      if (!state.alive) {
        return originalSave(annotation, instant);
      }
      captureNativeTextAnnotation(reader, annotation);
      invalidateMathAnnotationCache(reader);
      const result = originalSave(annotation, instant);
      if (hasMathAnnotation([annotation])) {
        scheduleRender(reader, true);
      }
      return result;
    }) as typeof manager._save;
  }

  state.patchedManagers.add(manager);
  patchViewAdjustTextAnnotationPosition(reader);
}

/**
 * Zotero 对"单行文本标注"会把用户拖出来的宽度改回源码文本宽度（最多 300pt），
 * 并且拖动后总是按源码重新算高度。数学标注的源码（`$...$`）比渲染结果长得多，
 * 所以这里直接接管 resize 调用：
 * - 宽度变了（左右/四角拖动）：按新宽度 + 渲染内容算出高度，返回新的 rect，
 *   不让 Zotero 用源码高度（这一步在 view 内部完成，不依赖后续 update 包装）。
 * - 宽度没变（上下拖动）：原样返回，保留用户拖出来的高度。
 * Zotero 改 comment 时那条带 `enableSingleLineMaxWidth` 的调用保持原生行为，
 * 原生文本标注也不受影响。
 */
function patchViewAdjustTextAnnotationPosition(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
): void {
  const internalReader = (
    reader as unknown as {
      _internalReader?: {
        _primaryView?: AdjustablePDFView;
        _secondaryView?: AdjustablePDFView;
        _lastView?: AdjustablePDFView;
      };
    }
  )._internalReader;
  for (const view of [
    internalReader?._primaryView,
    internalReader?._secondaryView,
    internalReader?._lastView,
  ]) {
    patchSingleViewAdjustTextAnnotationPosition(reader, view);
  }
}

function patchSingleViewAdjustTextAnnotationPosition(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  view: AdjustablePDFView | undefined,
): void {
  if (!view?.adjustTextAnnotationPosition) {
    return;
  }
  if (state.patchedViews.has(view)) {
    return;
  }
  const original = view.adjustTextAnnotationPosition.bind(view);
  view.adjustTextAnnotationPosition = (annotation, options) => {
    if (!state.alive) {
      return original(annotation, options);
    }
    try {
      const typed = annotation as _ZoteroTypes.Reader.Annotation;
      // `enableSingleLineMaxWidth` 是 Zotero 改 comment 时那条调用；保持原生
      // 行为，避免影响侧栏改正文。这里只接管拖动边框的 resize 调用。
      if (
        options?.enableSingleLineMaxWidth === true ||
        typed?.type !== "text" ||
        !parseAnnotationMath(typed)
      ) {
        return original(annotation, options);
      }
      const position = typed.position as
        | {
            rects?: number[][];
            rotation?: unknown;
            pageIndex?: unknown;
          }
        | undefined;
      const incomingRect = position?.rects?.[0];
      const rotation = Number(position?.rotation ?? 0);
      if (
        !incomingRect ||
        (Number.isFinite(rotation) && rotation % 360 !== 0)
      ) {
        return original(annotation, options);
      }

      const manager = getAnnotationManager(reader);
      const existing =
        manager?._getAnnotationByID?.(typed.id) ??
        getManagerAnnotations(manager).find((item) => item.id === typed.id);
      const oldRect = existing
        ? getPDFPosition(existing)?.rects?.[0]
        : undefined;
      const newWidth = Math.abs(incomingRect[2] - incomingRect[0]);
      const oldWidth = oldRect ? Math.abs(oldRect[2] - oldRect[0]) : Number.NaN;
      // 宽度没变 = 上下边框拖动：保留用户拖出来的高度，不让 Zotero 按源码重排。
      if (Number.isFinite(oldWidth) && Math.abs(newWidth - oldWidth) < 0.5) {
        return typed.position;
      }

      const doc =
        state.runtimes.get(reader)?.doc ?? state.readerDocs.get(reader);
      const pageIndex = Number(position?.pageIndex);
      if (doc && newWidth > 0) {
        const layoutScale = Number.isFinite(pageIndex)
          ? getDocZoom(doc, reader, pageIndex)
          : 1;
        const size = measureRichSource(
          doc,
          getMathContent(typed),
          getAnnotationFontSize(typed),
          { width: newWidth, layoutScale },
        );
        if (size) {
          const left = Math.min(incomingRect[0], incomingRect[2]);
          const top = Math.min(incomingRect[1], incomingRect[3]);
          const right = Math.max(incomingRect[0], incomingRect[2]);
          const nextPosition = {
            ...(position ?? {}),
            rects: [[left, top, right, top + size.height]],
          };
          return manager
            ? cloneIntoManagerRealm(manager, nextPosition)
            : nextPosition;
        }
      }

      // 量不出来时至少保留拖动宽度，高度交给 updateAnnotations 包装兜底。
      return original(annotation, {
        ...(options ?? {}),
        adjustSingleLineWidth: false,
      });
    } catch (error) {
      logError("Unable to adjust math annotation position", error);
    }
    return original(annotation, options);
  };
  state.patchedViews.add(view);
}

/**
 * 用户拖动标注边框时，Zotero 只更新 rect 宽高，不会按渲染后的内容重排。
 * 宽度变化（右边框/左右边框拖动）时按新宽度重新量高度并写回本次 update，
 * 避免一行内容仍占着两行高的框。只处理纯 position 更新（不带 comment）：
 * 插件自己的编辑保存已经量好尺寸，侧栏改正文走 comment 更新。
 */
function normalizeResizedMathAnnotationRects(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  updates: readonly _ZoteroTypes.Reader.Annotation[],
): void {
  if (!updates.length) {
    return;
  }
  patchViewAdjustTextAnnotationPosition(reader);
  const doc = state.runtimes.get(reader)?.doc ?? state.readerDocs.get(reader);
  const manager = getAnnotationManager(reader);
  if (!doc || !manager) {
    return;
  }

  for (const update of updates) {
    if (!update.id || update.comment !== undefined) {
      continue;
    }
    const position = update.position as
      | { rects?: number[][]; fontSize?: unknown; rotation?: unknown }
      | undefined;
    const incomingRect = position?.rects?.[0];
    if (!incomingRect) {
      continue;
    }
    const existing =
      manager._getAnnotationByID?.(update.id) ??
      getManagerAnnotations(manager).find(
        (annotation) => annotation.id === update.id,
      );
    if (
      !existing ||
      existing.type !== "text" ||
      !parseAnnotationMath(existing)
    ) {
      continue;
    }
    const existingPosition = existing.position as
      { rotation?: unknown; fontSize?: unknown } | undefined;
    const rotation = Number(existingPosition?.rotation ?? 0);
    const incomingRotation = Number(position?.rotation);
    if (
      (Number.isFinite(rotation) && rotation % 360 !== 0) ||
      (Number.isFinite(incomingRotation) && incomingRotation % 360 !== 0)
    ) {
      continue;
    }
    const oldRect = getPDFPosition(existing)?.rects?.[0];
    if (!oldRect) {
      continue;
    }
    const oldWidth = Math.abs(oldRect[2] - oldRect[0]);
    const newWidth = Math.abs(incomingRect[2] - incomingRect[0]);
    const rawFontSize = Number(position?.fontSize);
    const fontSize =
      Number.isFinite(rawFontSize) && rawFontSize > 0
        ? rawFontSize
        : getAnnotationFontSize(existing);
    const fontSizeChanged =
      Math.abs(fontSize - getAnnotationFontSize(existing)) >= 0.01;
    if (
      !(newWidth > 0) ||
      (Math.abs(newWidth - oldWidth) < 0.5 && !fontSizeChanged)
    ) {
      continue;
    }

    const positionPageIndex = getPDFPosition(existing)?.pageIndex;
    const layoutScale =
      typeof positionPageIndex === "number"
        ? getDocZoom(doc, reader, positionPageIndex)
        : 1;
    const size = measureRichSource(doc, getMathContent(existing), fontSize, {
      width: newWidth,
      layoutScale,
    });
    if (!size) {
      continue;
    }
    const top = Math.min(incomingRect[1], incomingRect[3]);
    const bottom = top + size.height;
    if (Math.abs(bottom - Math.max(incomingRect[1], incomingRect[3])) < 0.5) {
      continue;
    }

    const nextRect = [
      Math.min(incomingRect[0], incomingRect[2]),
      top,
      Math.max(incomingRect[0], incomingRect[2]),
      bottom,
    ];
    try {
      (update as { position: unknown }).position = {
        ...(position ?? {}),
        rects: cloneIntoManagerRealm(manager, [
          nextRect.map((value) => Number(value)),
        ]),
      };
    } catch (error) {
      logError("Unable to normalize resized math annotation height", error);
    }
  }
}

/**
 * Dispose the runtime when Zotero tears the reader down.
 *
 * `uninit()` is the common teardown path for both reader tabs and reader
 * windows (see Zotero's `ReaderTab.close()` / `ReaderWindow.close()`), so
 * wrapping it guarantees the MutationObservers and window listeners held by
 * the runtime are released when a PDF tab is closed — not just when the whole
 * plugin or window shuts down.
 */
export function patchReaderUninit(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
): void {
  if (state.patchedReaders.has(reader)) {
    return;
  }
  state.patchedReaders.add(reader);

  const originalUninit = reader.uninit?.bind(reader);
  if (!originalUninit) {
    return;
  }

  reader.uninit = () => {
    try {
      const runtime = state.runtimes.get(reader);
      if (runtime) {
        disposeRuntime(runtime);
      }
    } catch (error) {
      logError("Unable to dispose reader runtime", error);
    }
    return originalUninit();
  };
}
