/**
 * 混合文本 + 公式的 HTML 构建层。
 *
 * 只负责把 `RichDocument` 变成 HTML 字符串；KaTeX 渲染函数由调用方注入，
 * 这样这一层不依赖 Zotero，也可以单测文本转义和块级/行内结构。
 */

import type { RichDocument } from "./parse";

export type MathHtmlRenderer = (latex: string, display: boolean) => string;

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

/** 普通文本先转义再插入，KaTeX 输出是可信的，不走这里。 */
export function escapeHtmlText(value: string): string {
  return value.replace(/[&<>]/g, (char) => HTML_ESCAPES[char] ?? char);
}

/**
 * 返回 overlay 内容容器的 innerHTML。
 *
 * 文本段是块级容器（配合 CSS `white-space: pre-wrap`），行内公式是其中的
 * inline span；块级公式单独成块居中。块级公式前后不再额外包空段落
 * （解析阶段已经丢掉纯空白文本节点）。
 */
export function renderRichDocument(
  document: RichDocument,
  renderMath: MathHtmlRenderer,
): string {
  const parts: string[] = [];
  let textHtml = "";

  const flushText = () => {
    if (!textHtml) {
      return;
    }
    parts.push(`<div class="zotero-latex-math-rich-text">${textHtml}</div>`);
    textHtml = "";
  };

  for (const node of document.nodes) {
    if (node.type === "text") {
      textHtml += escapeHtmlText(node.value);
      continue;
    }

    if (node.type === "inline-math") {
      textHtml +=
        `<span class="zotero-latex-math-rich-inline">` +
        `${renderMath(node.latex, false)}</span>`;
      continue;
    }

    flushText();
    parts.push(
      `<div class="zotero-latex-math-rich-display">` +
        `${renderMath(node.latex, true)}</div>`,
    );
  }

  flushText();
  return parts.join("");
}
