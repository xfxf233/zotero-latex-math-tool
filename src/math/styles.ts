/**
 * 把插件样式注入 reader / 编辑器文档。KaTeX 字体以 data URL 内联，PDF 文档加载不了
 * chrome:// 资源。
 */
import katexStyles from "katex/dist/katex.min.css";
import toolStyles from "../styles.css";
import { katexFontURLs } from "../katexFonts";
import { STYLE_ID, TOOLBAR_STYLE_ID } from "./constants";

// 惰性缓存 `inlineKatexFonts` 的替换结果：输入 CSS 是模块常量，结果恒定，
// 避免每次注入样式 / 打开编辑器都对 1.1MB 字符串重复做正则替换。
let cachedInlineKatexCSS: string | undefined;

export function injectStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) {
    return;
  }

  const katexCSS = inlineKatexFonts(katexStyles);
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `${katexCSS}\n${toolStyles}`;
  doc.documentElement?.appendChild(style);
}

function inlineKatexFonts(css: string): string {
  if (cachedInlineKatexCSS !== undefined) {
    return cachedInlineKatexCSS;
  }
  cachedInlineKatexCSS = css
    .replace(/url\(fonts\/([^)]+\.woff2)\)/g, (_match, fileName: string) => {
      const url = katexFontURLs[fileName];
      if (!url && __env__ === "development") {
        // 升级 KaTeX 后可能出现 CSS 引用了内联表缺失的字体；静默降级成系统
        // 字体正是用户红线，dev 模式立即报警便于发现（仅在首次计算时检查）。
        Zotero.debug(
          `[LaTeX Math Tool] KaTeX font missing from inline map: ${fileName}`,
        );
      }
      return url ? `url(${url})` : `url(fonts/${fileName})`;
    })
    .replace(
      /,url\(fonts\/[^)]*\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g,
      "",
    );
  return cachedInlineKatexCSS;
}

export function injectToolbarStyles(doc: Document): void {
  if (doc.getElementById(TOOLBAR_STYLE_ID)) {
    return;
  }

  const style = doc.createElement("style");
  style.id = TOOLBAR_STYLE_ID;
  style.textContent = `
    .zotero-latex-math-toolbar-button {
      min-width: 32px;
      font-family: "Times New Roman", serif;
      font-size: 18px;
      font-weight: 700;
      line-height: 1;
    }
    .zotero-latex-math-toolbar-button.active,
    .zotero-latex-math-toolbar-button[aria-pressed="true"] {
      background: color-mix(in srgb, currentColor 18%, transparent) !important;
    }
  `;
  doc.documentElement?.appendChild(style);
}
