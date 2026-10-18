import assert from "node:assert/strict";
import test from "node:test";
import {
  getMathContentForAnnotation,
  hasMathTag,
  isMathAnnotationLike,
  parseMathContent,
  parseRichDocument,
} from "../../src/richText/parse.ts";
import type { RichDocument } from "../../src/richText/parse.ts";
import { renderRichDocument } from "../../src/richText/render.ts";

function rich(source: string): RichDocument {
  const content = parseMathContent(source);
  if (!content || content.kind !== "rich") {
    assert.fail(`expected rich content for: ${JSON.stringify(source)}`);
  }
  return content.document;
}

function inlineLatexes(document: RichDocument): string[] {
  return document.nodes
    .filter((node) => node.type === "inline-math")
    .map((node) => node.latex);
}

function displayLatexes(document: RichDocument): string[] {
  return document.nodes
    .filter((node) => node.type === "display-math")
    .map((node) => node.latex);
}

test("legacy prefixes still parse", () => {
  const display = parseMathContent("[[math:display]] x^2");
  assert.equal(display?.kind, "legacy");
  if (display?.kind === "legacy") {
    assert.equal(display.mode, "display");
    assert.equal(display.latex, "x^2");
  }

  const inline = parseMathContent("note [[math:inline]] y");
  assert.equal(inline?.kind, "legacy");
  if (inline?.kind === "legacy") {
    assert.equal(inline.mode, "inline");
    // 与旧实现一致：前缀前的文本被忽略。
    assert.equal(inline.latex, "y");
  }
});

test("plain text is not math", () => {
  assert.equal(parseMathContent("普通文本"), null);
  assert.equal(parseMathContent("价格 $5 and $10"), null);
  assert.equal(parseMathContent("$5-$10"), null);
  assert.equal(parseMathContent("$5$10"), null);
  assert.equal(parseMathContent("$ x$"), null);
  assert.equal(parseMathContent("$$$$"), null);
  assert.equal(parseMathContent("$$  $$"), null);
  assert.equal(parseMathContent("$x\ny$"), null);
  assert.equal(parseMathContent("$x"), null);
  assert.equal(parseMathContent("$$x"), null);
  assert.equal(parseMathContent("\\$5"), null);
  assert.equal(parseMathContent("\\$x$"), null);
});

test("inline formulas mix with text", () => {
  const document = rich("设 $x$，且 $y$。");
  assert.deepEqual(
    document.nodes.map((node) => node.type),
    ["text", "inline-math", "text", "inline-math", "text"],
  );
  assert.deepEqual(inlineLatexes(document), ["x", "y"]);
  assert.equal(document.mathCount, 2);
  assert.equal(document.nodes[0]?.type, "text");
  if (document.nodes[0]?.type === "text") {
    assert.equal(document.nodes[0].value, "设 ");
  }
});

test("display formulas are separate blocks", () => {
  const document = rich("前 $$x^2$$ 后");
  assert.deepEqual(
    document.nodes.map((node) => node.type),
    ["text", "display-math", "text"],
  );
  assert.deepEqual(displayLatexes(document), ["x^2"]);
  assert.equal(document.mathCount, 1);
});

test("display formulas may span lines", () => {
  const document = rich("$$\nx^2 + y^2\n$$");
  assert.deepEqual(displayLatexes(document), ["x^2 + y^2"]);
});

test("multiple formulas and newlines survive", () => {
  const document = rich("第一行\n第二行 $x$\n\n$$y$$\n\n结尾");
  assert.deepEqual(inlineLatexes(document), ["x"]);
  assert.deepEqual(displayLatexes(document), ["y"]);
  assert.equal(document.mathCount, 2);

  const firstText = document.nodes[0];
  assert.equal(firstText?.type, "text");
  if (firstText?.type === "text") {
    assert.equal(firstText.value, "第一行\n第二行 ");
  }
});

test("blank text around display math is dropped", () => {
  const document = rich("$$x$$\n\n$$y$$");
  assert.deepEqual(
    document.nodes.map((node) => node.type),
    ["display-math", "display-math"],
  );
});

test("escaped dollar signs stay literal", () => {
  assert.equal(parseMathContent("价格 \\$5"), null);
  assert.equal(parseMathContent("\\$x$"), null);

  const document = rich("\\$5 的公式是 $x$");
  assert.deepEqual(inlineLatexes(document), ["x"]);
  const firstText = document.nodes[0];
  if (firstText?.type === "text") {
    assert.equal(firstText.value, "$5 的公式是 ");
  }
});

test("escaped dollar inside math is not a closing delimiter", () => {
  const document = rich(String.raw`$a\$b$`);
  assert.deepEqual(inlineLatexes(document), [String.raw`a\$b`]);
});

test("escaped backslash before a delimiter", () => {
  const document = rich(String.raw`\\$x$`);
  assert.equal(document.nodes[0]?.type, "text");
  if (document.nodes[0]?.type === "text") {
    assert.equal(document.nodes[0].value, "\\");
  }
  assert.deepEqual(inlineLatexes(document), ["x"]);
});

test("empty or unterminated delimiters are literal", () => {
  const document = parseRichDocument("$$x$");
  assert.equal(document, null);
  assert.equal(parseRichDocument("a $$ b"), null);
});

test("renderer escapes text and keeps formula markup", () => {
  const document = rich("a <b> & $x$");
  const html = renderRichDocument(
    document,
    (latex, display) =>
      `<katex data-display="${String(display)}">${latex}</katex>`,
  );

  assert.ok(html.includes("a &lt;b&gt; &amp; "));
  assert.ok(!html.includes("<b>"));
  assert.ok(html.includes('class="zotero-latex-math-rich-inline"'));
  assert.ok(html.includes('<katex data-display="false">x</katex>'));
});

test("renderer builds display blocks", () => {
  const document = rich("前 $$x$$ 后");
  const html = renderRichDocument(
    document,
    (latex, display) =>
      `<katex data-display="${String(display)}">${latex}</katex>`,
  );

  assert.ok(html.includes('class="zotero-latex-math-rich-display"'));
  assert.ok(html.includes('<katex data-display="true">x</katex>'));
  assert.ok(html.indexOf("前") < html.indexOf("rich-display"));
  assert.ok(html.indexOf("rich-display") < html.indexOf("后"));
});

test("tag helper accepts string and object forms", () => {
  assert.equal(hasMathTag([{ name: "mathtool" }]), true);
  assert.equal(hasMathTag([{ tag: "mathtool" }]), true);
  assert.equal(hasMathTag(["mathtool"]), true);
  assert.equal(hasMathTag({ name: "mathtool" }), true);
  assert.equal(hasMathTag("mathtool"), true);
  assert.equal(hasMathTag([{ name: "other" }]), false);
  assert.equal(hasMathTag({ name: "other" }), false);
  assert.equal(hasMathTag(undefined), false);
});

test("tag identifies plugin annotations only", () => {
  assert.equal(
    isMathAnnotationLike({
      type: "text",
      comment: "$x$",
      tags: [],
    }),
    false,
  );
  assert.equal(
    isMathAnnotationLike({
      type: "text",
      comment: "普通文本",
      tags: [{ name: "mathtool" }],
    }),
    true,
  );
  assert.equal(
    isMathAnnotationLike({
      type: "text",
      comment: "[[math:inline]] x",
      tags: [],
    }),
    true,
  );
  assert.equal(
    isMathAnnotationLike({
      type: "note",
      comment: "[[math:inline]] x",
    }),
    false,
  );
});

test("tagged annotation without formulas is not renderable", () => {
  assert.equal(
    getMathContentForAnnotation({
      type: "text",
      comment: "普通文本",
      tags: [{ name: "mathtool" }],
    }),
    null,
  );
  const content = getMathContentForAnnotation({
    type: "text",
    comment: "$x$",
    tags: [{ name: "mathtool" }],
  });
  assert.equal(content?.kind, "rich");
});
