/**
 * 标注写入层：创建/更新标注、补 mathtool tag、写 pageLabel 元数据。
 *
 * 正文只写 `comment` 并把 `text` 清空；tag 只写 `{ name: "mathtool" }`，
 * 原因见 docs/zotero-runtime.md。
 */
import { MATH_ANNOTATION_TAG, parseMathContent } from "../richText/parse";
import {
  getAnnotationFontSize,
  getAnnotationLayoutWidth,
  getAnnotationManager,
  getManagerAnnotations,
  getMathAnnotations,
  getPDFPosition,
} from "./annotationData";
import {
  getPreferredAnnotationColor,
  normalizeAnnotationColor,
} from "./colors";
import { MATH_BASE_FONT_SIZE } from "./constants";
import { logCreateDiagnostics } from "./diagnostics";
import { createSortIndex, getDocZoom, getPageLabel } from "./geometry";
import {
  getRichAnnotationRect,
  measureRichSource,
  resizeAnnotationRect,
} from "./measure";
import { cloneIntoManagerRealm } from "./realm";
import type { AnnotationManager, ClickLocation, FormulaSize } from "./types";

/**
 * Backfill the derived `pageLabel` field for math annotations that lack it.
 *
 * Runs at explicit lifecycle points (reader init, annotation set/update) —
 * never on the render path — so rendering does not write to the annotation
 * store or cascade extra renders. In-memory only; Zotero re-derives the label
 * when annotations are reloaded.
 */
export function ensureAnnotationMetadata(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
): void {
  const manager = getAnnotationManager(reader);
  if (!manager) {
    return;
  }
  for (const annotation of getMathAnnotations(reader)) {
    if (annotation.pageLabel) {
      continue;
    }
    const position = getPDFPosition(annotation);
    if (!position) {
      continue;
    }
    annotation.pageLabel = getPageLabel(reader, position.pageIndex);
  }
}

export async function createAnnotationWithManager(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  manager: AnnotationManager,
  location: ClickLocation,
  source: string,
  doc?: Document,
  baseFontSize: number = MATH_BASE_FONT_SIZE,
  renderedSize?: FormulaSize,
  color?: string,
): Promise<void> {
  if (!manager.addAnnotation) {
    throw new Error("Reader annotation manager is not available");
  }

  const rect = getRichAnnotationRect(
    reader,
    doc,
    location,
    source,
    baseFontSize,
    renderedSize,
  );

  // 只传最小入参：id/日期/作者由 Zotero 的 addAnnotation 生成补全，
  // 插件不再手工拼 Zotero 的内部对象格式。正文必须放 comment、text 留空
  // （侧栏编辑只更新 comment，写 text 会读到旧值导致公式不同步）。
  // 阅读器内部标注 tag 是 { name, color? }；Zotero 保存时 fromJSON 再把
  // name 转成条目 tag 的 { tag }。传 { tag } 或字符串会因取不到 name 报
  // "Tag data must contain 'tag' property"（2026-10 真机 + Zotero 源码确认）。
  const rawAnnotation = {
    type: "text",
    color: normalizeAnnotationColor(color) ?? getPreferredAnnotationColor(),
    pageLabel: getPageLabel(reader, location.pageIndex, doc),
    sortIndex: createSortIndex(location),
    position: {
      pageIndex: location.pageIndex,
      // fontSize/rotation 不在 PDFPosition 类型内，但 Zotero 的 addAnnotation
      // 对 text 标注必需（真机验证：去掉会直接报错）。
      fontSize: baseFontSize,
      rotation: 0,
      rects: [rect],
    },
    comment: source,
    tags: [{ name: MATH_ANNOTATION_TAG }],
  } as unknown as Parameters<typeof manager.addAnnotation>[0];

  const beforeList = manager._annotations;
  const beforeLength = Array.isArray(beforeList)
    ? beforeList.length
    : ((beforeList as { size?: number } | undefined)?.size ?? 0);
  const annotation = cloneIntoManagerRealm(manager, rawAnnotation);
  const created = manager.addAnnotation(annotation);

  if (!created) {
    throw new Error(
      "addAnnotation returned null — Zotero did not create the text annotation",
    );
  }

  ensureMathTag(manager, created);
  logCreateDiagnostics(reader, manager, {
    annotation,
    created,
    beforeLength,
    phase: "pre-save",
  });
  manager._save?.(created, true);
  logCreateDiagnostics(reader, manager, {
    annotation,
    created,
    beforeLength,
    phase: "post-save",
  });
}

function ensureMathTag(
  manager: AnnotationManager,
  annotation: _ZoteroTypes.Reader.Annotation,
): void {
  const rawTags = annotation.tags as unknown;
  const existingTags = Array.isArray(rawTags)
    ? rawTags
    : typeof rawTags === "string" || (rawTags && typeof rawTags === "object")
      ? [rawTags]
      : [];

  // 阅读器内部标注 tag 是 { name, color? }；Zotero.Annotations.fromJSON 会用
  // t.name 生成条目 tag 的 { tag }。所以这里必须写 name，写 { tag } 或字符串
  // 会在保存时报 "Tag data must contain 'tag' property"。
  const normalizedTags = existingTags.map((tag) => {
    if (typeof tag === "string") {
      return { name: tag };
    }
    if (tag && typeof tag === "object") {
      const record = tag as { name?: unknown; tag?: unknown };
      if (typeof record.name === "string") {
        return tag;
      }
      if (typeof record.tag === "string") {
        return { name: record.tag };
      }
    }
    return tag;
  });

  const hasTag = normalizedTags.some(
    (tag) =>
      tag !== null &&
      typeof tag === "object" &&
      (tag as { name?: unknown }).name === MATH_ANNOTATION_TAG,
  );
  const tags = hasTag
    ? normalizedTags
    : [...normalizedTags, { name: MATH_ANNOTATION_TAG }];

  (annotation as { tags?: unknown }).tags = cloneIntoManagerRealm(
    manager,
    tags,
  );
}

export async function updateManagerAnnotation(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  annotation: _ZoteroTypes.Reader.Annotation,
  source: string,
  doc?: Document,
  baseFontSize: number = getAnnotationFontSize(annotation),
  renderedSize?: FormulaSize,
  color?: string,
): Promise<void> {
  const manager = getAnnotationManager(reader);
  if (!manager) {
    throw new Error("Reader annotation manager is not available");
  }

  const content = parseMathContent(source);
  if (content) {
    ensureMathTag(manager, annotation);
  }
  annotation.text = undefined;
  annotation.comment = source;
  const normalizedColor = normalizeAnnotationColor(color);
  if (normalizedColor) {
    annotation.color = normalizedColor;
  }

  if (doc && content) {
    const position = getPDFPosition(annotation);
    if (position) {
      const zoom = getDocZoom(doc, reader, position.pageIndex);
      const size =
        renderedSize ??
        measureRichSource(doc, source, baseFontSize, {
          width: getAnnotationLayoutWidth(annotation),
          layoutScale: zoom,
        });
      if (size) {
        resizeAnnotationRect(reader, manager, annotation, doc, {
          width: size.width * zoom,
          height: size.height * zoom,
        });
      }
    }
  }

  annotation.dateModified = new Date().toISOString();
  manager.updateAnnotations?.(replaceManagedAnnotation(manager, annotation));
  manager._save?.(annotation, true);
}

export async function updateManagerAnnotationByID(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  annotationID: string,
  source: string,
  doc?: Document,
  baseFontSize?: number,
  renderedSize?: FormulaSize,
  color?: string,
): Promise<void> {
  const manager = getAnnotationManager(reader);
  const annotation =
    manager?._getAnnotationByID?.(annotationID) ??
    getManagerAnnotations(manager).find(
      (candidate) => candidate.id === annotationID,
    );
  if (!annotation) {
    throw new Error("Unable to resolve the underlying Zotero annotation");
  }

  await updateManagerAnnotation(
    reader,
    annotation,
    source,
    doc,
    baseFontSize,
    renderedSize,
    color,
  );
}

function replaceManagedAnnotation(
  manager: AnnotationManager,
  annotation: _ZoteroTypes.Reader.Annotation,
): _ZoteroTypes.Reader.Annotation[] {
  const list = manager._annotations;
  if (Array.isArray(list)) {
    const index = list.findIndex((candidate) => candidate.id === annotation.id);
    if (index === -1) {
      list.push(annotation);
    } else {
      list[index] = annotation;
    }
    return list.filter((candidate) => candidate.id === annotation.id);
  }
  // 非数组（Set 等）无法就地替换：把当前标注直接交给 Zotero 更新即可。
  return [annotation];
}
