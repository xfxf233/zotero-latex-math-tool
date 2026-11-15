/**
 * 内容模型上的布局判断（纯函数）：是否只有一个纯公式、legacy 标注如何迁移成新语法。
 *
 * 不依赖 Zotero / DOM，可单测。
 */
import type { MathContent, MathMode } from "./parse";

export function legacyToRichSource(content: {
  latex: string;
  mode: MathMode;
}): string {
  // 旧行内公式若含换行，用块级语法迁移，避免新解析器把行内公式当成未闭合。
  if (content.mode === "display" || content.latex.includes("\n")) {
    return `$$\n${content.latex}\n$$`;
  }
  return "$" + content.latex + "$";
}

/**
 * 只有一个公式、没有任何普通文本时返回该公式；legacy 标注也算纯公式。
 * 其余情况返回 undefined，走 rich 布局。
 */
export function getSingleFormula(
  content: MathContent,
): { latex: string; mode: MathMode } | undefined {
  if (content.kind === "legacy") {
    return { latex: content.latex, mode: content.mode };
  }

  const nodes = content.document.nodes.filter(
    (node) => node.type !== "text" || node.value.trim().length > 0,
  );
  if (nodes.length !== 1) {
    return undefined;
  }
  const node = nodes[0];
  if (node.type === "inline-math") {
    return { latex: node.latex, mode: "inline" };
  }
  if (node.type === "display-math") {
    return { latex: node.latex, mode: "display" };
  }
  return undefined;
}
