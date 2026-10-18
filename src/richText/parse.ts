/**
 * 混合文本 + 公式的纯解析层。
 *
 * 这里只做字符串到文档模型的转换，不依赖 Zotero / DOM / KaTeX，便于单测。
 * 识别规则、语法与边界见 dev-notes/rich-text-spec.md。
 */

export const MATH_ANNOTATION_TAG = "mathtool";

const DISPLAY_PREFIX = "[[math:display]]";
const INLINE_PREFIX = "[[math:inline]]";

export type MathMode = "display" | "inline";

export type RichNode =
  | { type: "text"; value: string }
  | { type: "inline-math"; latex: string }
  | { type: "display-math"; latex: string };

export type RichDocument = {
  nodes: RichNode[];
  mathCount: number;
};

export type LegacyMathContent = {
  kind: "legacy";
  latex: string;
  mode: MathMode;
};

export type RichMathContent = {
  kind: "rich";
  document: RichDocument;
};

export type MathContent = LegacyMathContent | RichMathContent;

/**
 * 旧版协议只用于兼容已有标注；新标注不再写入前缀。
 *
 * 保持与旧实现一致的 `indexOf` 语义：前缀前面的文本仍然被忽略，避免旧数据行为变化。
 */
export function parseLegacyMath(source: string): LegacyMathContent | null {
  const trimmed = source.trim();
  const displayIndex = trimmed.indexOf(DISPLAY_PREFIX);
  if (displayIndex >= 0) {
    return {
      kind: "legacy",
      mode: "display",
      latex: trimmed.slice(displayIndex + DISPLAY_PREFIX.length).trim(),
    };
  }

  const inlineIndex = trimmed.indexOf(INLINE_PREFIX);
  if (inlineIndex >= 0) {
    return {
      kind: "legacy",
      mode: "inline",
      latex: trimmed.slice(inlineIndex + INLINE_PREFIX.length).trim(),
    };
  }

  return null;
}

export function hasLegacyMathPrefix(source: string): boolean {
  return source.includes(DISPLAY_PREFIX) || source.includes(INLINE_PREFIX);
}

/**
 * 新格式解析。只有至少包含一个公式节点时才返回文档；纯文本返回 null。
 */
export function parseRichMath(source: string): RichMathContent | null {
  const document = parseRichDocument(source);
  return document ? { kind: "rich", document } : null;
}

export function parseRichDocument(source: string): RichDocument | null {
  const normalized = source.trim();
  if (!normalized) {
    return null;
  }

  const nodes: RichNode[] = [];
  let text = "";
  let mathCount = 0;

  const flushText = () => {
    if (!text) {
      return;
    }
    nodes.push({ type: "text", value: text });
    text = "";
  };

  let index = 0;
  while (index < normalized.length) {
    const char = normalized[index];

    // 文本里的 \$ 和 \\ 是转义；其他反斜杠原样保留（例如 \alpha 在公式外按文本显示）。
    if (char === "\\") {
      const next = normalized[index + 1];
      if (next === "$" || next === "\\") {
        text += next;
        index += 2;
        continue;
      }
      text += char;
      index += 1;
      continue;
    }

    if (char !== "$") {
      text += char;
      index += 1;
      continue;
    }

    if (normalized[index + 1] === "$") {
      const close = findDisplayClose(normalized, index + 2);
      if (close !== -1) {
        const latex = normalized.slice(index + 2, close).trim();
        if (latex) {
          flushText();
          nodes.push({ type: "display-math", latex });
          mathCount += 1;
          index = close + 2;
          continue;
        }
      }
      // 未闭合或空公式：两个 $ 都按普通文本处理。
      text += "$$";
      index += 2;
      continue;
    }

    if (canOpenInline(normalized, index)) {
      const close = findInlineClose(normalized, index + 1);
      if (close !== -1) {
        const latex = normalized.slice(index + 1, close).trim();
        if (latex) {
          flushText();
          nodes.push({ type: "inline-math", latex });
          mathCount += 1;
          index = close + 1;
          continue;
        }
      }
    }

    text += char;
    index += 1;
  }

  flushText();

  if (mathCount === 0) {
    return null;
  }

  return {
    nodes: dropBlankTextAroundDisplay(nodes),
    mathCount,
  };
}

/**
 * 兼容旧前缀和新语法。识别来源（tag / 旧前缀）由调用方先做；
 * 这个函数只负责"这段文本里到底有没有公式"。
 */
export function parseMathContent(source: string): MathContent | null {
  return parseLegacyMath(source) ?? parseRichMath(source);
}

export type MathAnnotationLike = {
  type?: unknown;
  comment?: unknown;
  tags?: unknown;
};

/**
 * 判断一条标注是否属于插件管理的数学标注。
 *
 * 只做便宜的 tag / 旧前缀检查，不解析正文；调用方还应再用
 * `parseMathContent` 确认确实含公式（带 tag 但内容已改成纯文本的标注会返回 null）。
 */
export function isMathAnnotationLike(annotation: MathAnnotationLike): boolean {
  if (annotation.type !== "text") {
    return false;
  }

  const comment =
    typeof annotation.comment === "string" ? annotation.comment : "";
  return hasMathTag(annotation.tags) || hasLegacyMathPrefix(comment);
}

/**
 * 识别 + 解析一次完成。纯文本标注、带 tag 但无公式的标注都会返回 null。
 */
export function getMathContentForAnnotation(
  annotation: MathAnnotationLike,
): MathContent | null {
  if (!isMathAnnotationLike(annotation)) {
    return null;
  }

  const comment =
    typeof annotation.comment === "string" ? annotation.comment : "";
  return parseMathContent(comment);
}

/**
 * Zotero 阅读器内部标注 tag 是 `[{ name: "mathtool", color? }]`；保存到条目时
 * `Zotero.Annotations.fromJSON` 会用 `t.name` 生成 `{ tag }`。这里兼容
 * `{ name }` / `{ tag }` / string 和单对象形态，避免不同内部容器/旧数据识别失败。
 */
export function hasMathTag(tags: unknown): boolean {
  const list = Array.isArray(tags)
    ? tags
    : typeof tags === "string" || (tags && typeof tags === "object")
      ? [tags]
      : [];

  return list.some((tag) => {
    if (typeof tag === "string") {
      return tag === MATH_ANNOTATION_TAG;
    }
    if (tag && typeof tag === "object") {
      const record = tag as { name?: unknown; tag?: unknown };
      return (
        record.name === MATH_ANNOTATION_TAG ||
        record.tag === MATH_ANNOTATION_TAG
      );
    }
    return false;
  });
}

function canOpenInline(source: string, index: number): boolean {
  const next = source[index + 1];
  return next !== undefined && next !== "$" && !/\s/.test(next);
}

function findInlineClose(source: string, start: number): number {
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\n" || char === "\r") {
      return -1;
    }
    if (char !== "$" || isEscaped(source, index)) {
      continue;
    }

    // 行内公式不能为空；闭合符前不能是空白，后面不能紧跟数字
    // （Pandoc 规则，避免把 `$5 and $10` 识别成公式）。
    if (
      index === start ||
      /\s/.test(source[index - 1]) ||
      /\d/.test(source[index + 1] ?? "")
    ) {
      return -1;
    }

    return index;
  }

  return -1;
}

function findDisplayClose(source: string, start: number): number {
  for (let index = start; index < source.length - 1; index += 1) {
    if (source[index] !== "$" || source[index + 1] !== "$") {
      continue;
    }
    if (isEscaped(source, index)) {
      continue;
    }
    return index;
  }

  return -1;
}

/**
 * 公式内的 `$` 是否被反斜杠转义：数前面连续反斜杠的个数，奇数视为转义。
 * 这样 `\\$$` 里的 `\\` 是转义反斜杠，后面的 `$$` 仍能闭合。
 */
function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && source[cursor] === "\\";
    cursor -= 1
  ) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/**
 * 块级公式前后的纯空白文本节点会变成空段落，丢弃；行内公式之间的空格保留。
 */
function dropBlankTextAroundDisplay(nodes: RichNode[]): RichNode[] {
  return nodes.filter((node, index) => {
    if (node.type !== "text" || node.value.trim()) {
      return true;
    }
    const previous = nodes[index - 1];
    const next = nodes[index + 1];
    return previous?.type !== "display-math" && next?.type !== "display-math";
  });
}
