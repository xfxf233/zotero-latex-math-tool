/**
 * 标注只读访问层：内容读取、解析缓存、tag/位置访问，以及"这个 reader 有没有数学
 * 标注"的 O(1) 判断。
 *
 * 所有内容读取只走 `annotation.comment`（`text` 恒为空），见 docs/zotero-runtime.md。
 */
import {
  hasLegacyMathPrefix,
  hasMathTag,
  parseMathContent,
} from "../richText/parse";
import type { MathContent } from "../richText/parse";
import { MATH_BASE_FONT_SIZE } from "./constants";
import { state } from "./state";
import type { AnnotationManager } from "./types";

/**
 * 自由文本标注的正文在 `comment` 字段，`text` 恒为空。只读 comment 可避免
 * `text ?? comment` 遇空串不落地的坑（`"" ?? comment` 返回空串，导致数学
 * 标注识别失败、渲染被短路）。所有数学内容读取一律走这里。
 */
export function getMathContent(
  annotation: _ZoteroTypes.Reader.Annotation,
): string {
  return annotation.comment ?? "";
}

export function getAnnotationFontSize(
  annotation: _ZoteroTypes.Reader.Annotation,
): number {
  const value = Number(
    (annotation.position as { fontSize?: unknown }).fontSize,
  );
  return Number.isFinite(value) && value > 0 ? value : MATH_BASE_FONT_SIZE;
}

/**
 * 标注当前 rect 的宽度（PDF 单位）。编辑已有标注时按这个宽度重排版，
 * 保留用户手动拉宽的框；保存时只重算高度。
 */
export function getAnnotationLayoutWidth(
  annotation: _ZoteroTypes.Reader.Annotation,
): number | undefined {
  const rect = getPDFPosition(annotation)?.rects?.[0];
  if (!rect) {
    return undefined;
  }
  const width = Math.abs(rect[2] - rect[0]);
  return width > 0 ? width : undefined;
}

/**
 * 识别 + 解析一条标注的内容。解析结果按 comment 原文缓存；tag / 旧前缀的
 * 来源判断每次都要做（同一段文本可能先被加 tag 再变成数学标注）。
 */
export function parseAnnotationMath(
  annotation: _ZoteroTypes.Reader.Annotation,
): MathContent | null {
  if (annotation.type !== "text") {
    return null;
  }

  const source = getMathContent(annotation);
  // 先做便宜的来源判断：原生文本标注（没有 mathtool tag、也没有旧前缀）
  // 根本不解析正文，避免每次渲染把所有普通文本标注都过一遍解析器。
  if (!hasMathTag(annotation.tags) && !hasLegacyMathPrefix(source)) {
    return null;
  }

  let content = state.mathContentCache.get(source);
  if (content === undefined) {
    content = parseMathContent(source);
    if (state.mathContentCache.size >= 200) {
      state.mathContentCache.clear();
    }
    state.mathContentCache.set(source, content);
  }
  return content;
}

export function hasMathAnnotation(
  annotations: _ZoteroTypes.Reader.Annotation[] | undefined,
): boolean {
  return Boolean(
    annotations?.some((annotation) => parseAnnotationMath(annotation) !== null),
  );
}

export function getManagerAnnotationCount(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
): number {
  const list = getAnnotationManager(reader)?._annotations;
  return Array.isArray(list)
    ? list.length
    : ((list as { size?: number } | undefined)?.size ?? 0);
}

/**
 * Cheap "does this reader hold any math annotation" check for the observer
 * hot path. `_annotations.length` is the invalidation key, so adds/deletes
 * recompute while the steady state costs a single property read plus map
 * lookups — never a full scan on every mutation batch.
 */
export function readerHasMath(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
): boolean {
  const count = getManagerAnnotationCount(reader);
  if (state.mathAnnotationCacheCounts.get(reader) === count) {
    const cached = state.mathAnnotationCache.get(reader);
    if (cached !== undefined) {
      return cached;
    }
  }
  const has = getMathAnnotations(reader).length > 0;
  state.mathAnnotationCacheCounts.set(reader, count);
  state.mathAnnotationCache.set(reader, has);
  return has;
}

/**
 * 使 `readerHasMath` 的缓存失效。失效键（标注数量）在"编辑标注 comment
 * 使数学↔非数学变化而数量不变"时不会变化，缓存会返回陈旧值，导致 zoom
 * 重建标注层时原始 `[[math:…]]` 文本闪一帧。所有修改标注内容的入口
 * （updateAnnotations / setAnnotations / _save 补丁）都应显式失效。
 */
export function invalidateMathAnnotationCache(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
): void {
  state.mathAnnotationCache.delete(reader);
  state.mathAnnotationCacheCounts.delete(reader);
  state.mathControlCache.delete(reader);
}

/**
 * 安全读取 annotation manager 内部的标注列表。
 *
 * 列表正常是数组（真机确认），但 Zotero 内部结构出过非数组的先例
 * （`_unsavedAnnotations` 真机为 Map），所以渲染链路里不能假定数组——
 * 非数组时退化为 Array.from 而不是直接抛错。数组分支是零开销的原引用返回。
 */
export function getManagerAnnotations(
  manager: AnnotationManager | undefined,
): _ZoteroTypes.Reader.Annotation[] {
  const list = manager?._annotations;
  if (Array.isArray(list)) {
    return list;
  }
  if (list) {
    return Array.from(
      list as unknown as Iterable<_ZoteroTypes.Reader.Annotation>,
    );
  }
  return [];
}

export function getMathAnnotations(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
): _ZoteroTypes.Reader.Annotation[] {
  const manager = getAnnotationManager(reader);
  return getManagerAnnotations(manager).filter(
    (annotation) => parseAnnotationMath(annotation) !== null,
  );
}

/**
 * updateAnnotations 的入参可能是 partial；按 id 从 manager 当前列表取回合并后的
 * 完整标注，供渲染调度/元数据判断使用。
 */
export function resolveAnnotationsById(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  annotations: readonly _ZoteroTypes.Reader.Annotation[],
): _ZoteroTypes.Reader.Annotation[] {
  if (!annotations.length) {
    return [];
  }

  const manager = getAnnotationManager(reader);
  if (!manager) {
    return [];
  }

  const byId = new Map(
    getManagerAnnotations(manager).map((annotation) => [
      annotation.id,
      annotation,
    ]),
  );
  const resolved: _ZoteroTypes.Reader.Annotation[] = [];
  for (const annotation of annotations) {
    const full = annotation.id ? byId.get(annotation.id) : undefined;
    if (full) {
      resolved.push(full);
    }
  }
  return resolved;
}

export function getPDFPosition(annotation: _ZoteroTypes.Reader.Annotation):
  | {
      pageIndex: number;
      rects?: number[][];
      paths?: number[][];
    }
  | undefined {
  const position = annotation.position as {
    pageIndex?: unknown;
    rects?: number[][];
    paths?: number[][];
  };
  if (typeof position.pageIndex !== "number") {
    return undefined;
  }
  return {
    pageIndex: position.pageIndex,
    rects: position.rects,
    paths: position.paths,
  };
}

export function getAnnotationManager(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
): AnnotationManager | undefined {
  return reader._internalReader?._annotationManager as
    AnnotationManager | undefined;
}
