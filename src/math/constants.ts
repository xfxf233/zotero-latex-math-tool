/**
 * 插件注入 DOM 的类名/样式 id 与排版常量。
 *
 * 这些值同时被 CSS（`src/styles.css`）、overlay 构建和编辑器使用，集中在一处避免
 * 字符串各写一份。改类名要同步改 styles.css。
 */

export const STYLE_ID = "zotero-latex-math-tool-styles";
export const TOOLBAR_STYLE_ID = "zotero-latex-math-tool-toolbar-styles";
export const MANAGER_RENDER_CLASS = "zotero-latex-math-manager-render";
export const PAGE_OVERLAY_CLASS = "zotero-latex-math-page-overlay";
export const RAW_HIDDEN_CLASS = "zotero-latex-math-raw-hidden";
export const FIT_CONTENT_CLASS = "zotero-latex-math-fit-content";
export const RICH_CONTENT_CLASS = "zotero-latex-math-rich-content";
export const RICH_MEASURE_CLASS = "zotero-latex-math-rich-measure";
export const EDITOR_FRAME_CLASS = "zotero-latex-math-editor-frame";

// 混合内容的排版基准：测量与 overlay 都按 14px（PDF 单位）排版，再整体按
// 当前缩放做 transform，缩放时不重排。行高必须与 styles.css 保持一致。
export const MATH_BASE_FONT_SIZE = 14;
export const RICH_LINE_HEIGHT = 1.4;
export const RICH_TEXT_MAX_WIDTH = 320;
// 宽度硬上限：纯公式和用户手动拉宽的框都按 720pt 截断。
export const RICH_MAX_WIDTH = 720;

// 选中公式后再按下：指针移动超过该像素数视为拖动（松手不弹编辑器），
// 未拖动才视为"再点一下"（松手弹编辑器）。量级与浏览器点击判定一致。
export const CLICK_DRAG_THRESHOLD_PX = 5;
