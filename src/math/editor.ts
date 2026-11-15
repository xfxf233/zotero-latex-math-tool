/**
 * 公式编辑器弹窗：独立 iframe 内渲染输入框 + 实时预览 + 调色板，保存前在同一文档里
 * 测量内容尺寸。
 *
 * 编辑器 iframe 是临时 UI，不会被纳入渲染观察（见 readerDocs.getRuntimeDocuments）。
 */
import { legacyToRichSource } from "../richText/layout";
import { parseMathContent } from "../richText/parse";
import type { MathContent } from "../richText/parse";
import { getString } from "../utils/locale";
import { getMathContent } from "./annotationData";
import {
  ANNOTATION_COLOR_LABEL_KEYS,
  getAnnotationColorPalette,
  getPreferredAnnotationColor,
  normalizeAnnotationColor,
  rememberAnnotationColor,
} from "./colors";
import { EDITOR_FRAME_CLASS } from "./constants";
import { renderLatex, renderRichContentHtml } from "./katex";
import { measureRichSource } from "./measure";
import { injectStyles } from "./styles";
import type { FormulaSize } from "./types";
import { escapeHTML, stringifyError } from "./util";

/**
 * 编辑器里显示的源码：旧前缀标注迁移成新语法，混合内容直接显示原文。
 * 取消编辑不会写回，因此这里的迁移只在用户点保存后生效。
 */
export function getEditorSource(
  annotation: _ZoteroTypes.Reader.Annotation,
  content: MathContent,
): string {
  if (content.kind === "rich") {
    return getMathContent(annotation);
  }
  return legacyToRichSource(content);
}

export async function openEditorInDocument(
  doc: Document,
  options: {
    title: string;
    initialSource: string;
    isNew: boolean;
    baseFontSize: number;
    /**
     * 编辑已有标注时传入它当前的 PDF 宽度：按这个宽度重新排版/量高度，
     * 不把用户手动拉宽的框改回 320pt 自动换行宽度。
     */
    layoutWidth?: number;
    /** 编辑器打开时选中的颜色；新插入用上次记住的颜色，编辑用标注当前颜色。 */
    initialColor: string;
    /**
     * 新插入时即使没点色点也把 initialColor 写进新标注，保证保存的颜色与
     * 编辑器里看到的一致；编辑/兜底路径不设，避免覆盖标注原本的颜色。
     */
    applyInitialColorOnSave?: boolean;
    onSave: (
      source: string,
      renderedSize: FormulaSize | undefined,
      /** 用户主动选过颜色才有值；undefined 表示保持标注原色。 */
      color: string | undefined,
    ) => Promise<void> | void;
  },
): Promise<void> {
  const editorHost = createEditorHost(doc);
  const editorDoc = editorHost.doc;
  injectStyles(editorDoc);

  const create = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
  ): HTMLElementTagNameMap[K] =>
    editorDoc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      tag,
    ) as HTMLElementTagNameMap[K];

  const overlay = create("div");
  overlay.className = "zotero-latex-math-modal";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const panel = create("form");
  panel.className = "zotero-latex-math-dialog";

  const title = create("h2");
  title.textContent = options.title;

  const input = create("textarea");
  input.className = "zotero-latex-math-input";
  input.value = options.initialSource;
  input.placeholder = getString("math-editor-placeholder");
  input.rows = 7;

  const preview = create("div");
  preview.className = "zotero-latex-math-preview";

  let selectedColor =
    normalizeAnnotationColor(options.initialColor) ??
    getPreferredAnnotationColor();
  // 只有用户主动点过色点才在保存时写回颜色。这样编辑已有标注时，即使它的
  // color 不是插件能识别的十六进制（例如外部导入的值），只改正文也不会被
  // 悄悄覆盖成默认色。
  let colorTouched = false;

  const colorRow = create("div");
  colorRow.className = "zotero-latex-math-colors";
  colorRow.setAttribute("role", "group");
  colorRow.setAttribute("aria-label", getString("math-editor-color-label"));

  const colorLabel = create("span");
  colorLabel.className = "zotero-latex-math-color-label";
  colorLabel.textContent = getString("math-editor-color-label");
  colorRow.appendChild(colorLabel);

  const swatches: HTMLButtonElement[] = [];
  for (const color of getAnnotationColorPalette()) {
    const swatch = create("button");
    swatch.type = "button";
    swatch.className = "zotero-latex-math-color-swatch";
    swatch.dataset.color = color;
    swatch.style.backgroundColor = color;
    const labelKey = ANNOTATION_COLOR_LABEL_KEYS[color];
    const label = labelKey ? getString(labelKey) : color;
    swatch.title = label;
    swatch.setAttribute("aria-label", label);
    swatch.setAttribute("aria-pressed", "false");
    swatches.push(swatch);
    colorRow.appendChild(swatch);
  }

  const actions = create("div");
  actions.className = "zotero-latex-math-actions";

  const cancel = create("button");
  cancel.type = "button";
  cancel.textContent = getString("math-editor-cancel");

  const save = create("button");
  save.type = "button";
  save.className = "primary";
  save.textContent = options.isNew
    ? getString("math-editor-insert")
    : getString("math-editor-save");

  actions.append(cancel, save);
  panel.append(title, input, colorRow, preview, actions);
  overlay.append(panel);
  editorDoc.documentElement?.appendChild(overlay);

  const stopShortcutPropagation = (event: Event) => {
    event.stopPropagation();
  };
  for (const eventName of ["keydown", "keypress", "keyup"]) {
    overlay.addEventListener(eventName, stopShortcutPropagation, true);
    panel.addEventListener(eventName, stopShortcutPropagation, true);
    input.addEventListener(eventName, stopShortcutPropagation, true);
  }

  const editorWindow = editorDoc.defaultView;
  let previewTimer: number | undefined;
  let closed = false;
  const clearPreviewTimer = () => {
    if (previewTimer !== undefined) {
      editorWindow?.clearTimeout(previewTimer);
      previewTimer = undefined;
    }
  };
  const close = () => {
    closed = true;
    clearPreviewTimer();
    editorHost.destroy();
  };

  const setSelectedColor = (value: unknown, remember: boolean) => {
    const normalized = normalizeAnnotationColor(value);
    if (!normalized) {
      return;
    }
    selectedColor = normalized;
    for (const swatch of swatches) {
      const active = swatch.dataset.color === normalized;
      swatch.setAttribute("aria-pressed", active ? "true" : "false");
    }
    if (preview.classList.contains("is-empty")) {
      preview.style.removeProperty("color");
    } else {
      preview.style.color = normalized;
    }
    // 选中即记住（不等保存）：用户选好颜色后取消，再插入新公式时仍是这个色。
    if (remember) {
      colorTouched = true;
      rememberAnnotationColor(normalized);
    }
  };

  const updatePreview = () => {
    const raw = input.value.trim();
    const source = normalizeEditorSource(raw, options.isNew);
    save.disabled = raw.length === 0;
    preview.classList.toggle("is-empty", source.length === 0);
    preview.innerHTML = source
      ? renderEditorPreview(source)
      : getString("math-editor-empty-preview");
    if (source.length === 0) {
      preview.style.removeProperty("color");
    } else {
      preview.style.color = selectedColor;
    }
  };

  const schedulePreview = () => {
    if (!editorWindow) {
      updatePreview();
      return;
    }
    clearPreviewTimer();
    previewTimer = editorWindow.setTimeout(updatePreview, 100);
  };

  let saving = false;
  const saveFormula = async () => {
    if (saving) {
      return;
    }
    const source = normalizeEditorSource(input.value.trim(), options.isNew);
    if (!source) {
      return;
    }

    // 先把当前内容渲染到预览，确保 KaTeX 字体已开始加载；接着等字体就绪，
    // 再在编辑器文档里量尺寸。编辑器文档与最终 overlay 共用同一套 CSS，
    // 这样量出来的宽度/高度不会受 reader 文档字体尚未加载的影响。
    saving = true;
    try {
      updatePreview();
      save.disabled = true;
      // 触发一次布局，让预览里的 KaTeX 字形开始加载，再等字体就绪后测量。
      preview.getBoundingClientRect();
      try {
        await editorDoc.fonts?.ready;
      } catch {
        // 字体 API 不可用时退回直接测量。
      }
      const renderedSize = measureRichSource(
        editorDoc,
        source,
        options.baseFontSize,
        { width: options.layoutWidth },
      );
      // 字体等待/测量期间用户可能已经取消（overlay 点击/Cancel）；不要在
      // 编辑器已销毁后继续创建/更新标注。
      if (closed) {
        return;
      }
      await options.onSave(
        source,
        renderedSize,
        colorTouched || options.applyInitialColorOnSave
          ? selectedColor
          : undefined,
      );
      close();
    } catch (error) {
      saving = false;
      const message = stringifyError(error);
      preview.classList.remove("is-empty");
      preview.innerHTML = `<span class="zotero-latex-math-error">${escapeHTML(
        message,
      )}</span>`;
      save.disabled = false;
    }
  };

  input.addEventListener("input", () => {
    // 防抖只影响预览；保存按钮的可用状态必须立刻跟上，否则用户输入后
    // 100ms 内点保存会点在一个 disabled 按钮上。
    save.disabled = input.value.trim().length === 0;
    schedulePreview();
  });
  for (const swatch of swatches) {
    swatch.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setSelectedColor(swatch.dataset.color, true);
    });
  }
  cancel.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  save.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void saveFormula();
  });
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      close();
    }
  });
  panel.addEventListener("submit", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await saveFormula();
  });

  setSelectedColor(selectedColor, false);
  updatePreview();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/**
 * 新建时输入不含 `$` 的整段内容按块级公式处理（Σ 仍是公式入口）；
 * 编辑已有标注则按原样保存，删掉 `$` 就是有意变成普通文本。
 */
function normalizeEditorSource(source: string, isNew: boolean): string {
  if (!source || !isNew) {
    return source;
  }
  return parseMathContent(source) ? source : `$$\n${source}\n$$`;
}

function renderEditorPreview(source: string): string {
  const content = parseMathContent(source);
  if (!content) {
    return escapeHTML(source);
  }
  if (content.kind === "legacy") {
    return renderLatex(content.latex, content.mode);
  }
  return renderRichContentHtml(content);
}

function createEditorHost(doc: Document): {
  doc: Document;
  destroy: () => void;
} {
  const frame = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "iframe",
  ) as HTMLIFrameElement;
  frame.className = EDITOR_FRAME_CLASS;
  frame.setAttribute("aria-hidden", "false");
  frame.style.position = "fixed";
  frame.style.inset = "0";
  frame.style.zIndex = "2147483647";
  frame.style.width = "100vw";
  frame.style.height = "100vh";
  frame.style.border = "0";
  frame.style.background = "transparent";
  doc.documentElement?.appendChild(frame);

  const frameDoc = frame.contentDocument;
  if (!frameDoc) {
    frame.remove();
    return { doc, destroy: () => undefined };
  }

  frameDoc.open();
  frameDoc.write(
    '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
  );
  frameDoc.close();
  (frameDoc.documentElement as HTMLElement | null)?.style.setProperty(
    "margin",
    "0",
  );
  frameDoc.body?.style.setProperty("margin", "0");

  return {
    doc: frameDoc,
    destroy: () => frame.remove(),
  };
}
