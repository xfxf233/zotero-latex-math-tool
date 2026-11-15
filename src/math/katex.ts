/**
 * KaTeX 渲染层：单公式 HTML（带缓存）与整段混合内容的 HTML。
 */
import { renderToString } from "katex";
import type { MathContent, MathMode } from "../richText/parse";
import { renderRichDocument } from "../richText/render";
import { state } from "./state";
import { escapeHTML } from "./util";

export function renderRichContentHtml(content: MathContent): string {
  if (content.kind !== "rich") {
    return "";
  }
  return renderRichDocument(content.document, (latex, display) =>
    renderLatex(latex, display ? "display" : "inline"),
  );
}

export function renderLatex(latex: string, mode: MathMode): string {
  const cacheKey = `${mode}\u0000${latex}`;
  const cached = state.katexHtmlCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  let html: string;
  try {
    html = renderToString(latex, {
      displayMode: mode === "display",
      throwOnError: false,
      strict: "ignore",
      trust: false,
      output: "htmlAndMathml",
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "KaTeX render failed";
    html = `<span class="zotero-latex-math-error">${escapeHTML(
      message,
    )}</span>`;
  }

  if (state.katexHtmlCache.size >= 200) {
    state.katexHtmlCache.clear();
  }
  state.katexHtmlCache.set(cacheKey, html);
  return html;
}
