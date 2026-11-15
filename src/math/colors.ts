/**
 * 标注颜色：规范化、调色板读取、上次使用的颜色偏好。
 */
import { config } from "../../package.json";
import type { FluentMessageId } from "../../typings/i10n";
import { logError } from "./log";

// Zotero 自带的 8 种标注颜色（Zotero 10：Zotero.Annotations.COLORS；旧版是
// DEFAULT_COLORS）。打开编辑器时优先读取运行中 Zotero 的调色板，这里只是
// 读不到时的兜底，保证按钮始终可用。
const FALLBACK_ANNOTATION_COLORS = [
  "#ffd400",
  "#ff6666",
  "#5fb236",
  "#2ea8e5",
  "#a28ae5",
  "#e56eee",
  "#f19837",
  "#aaaaaa",
];
// 调色板色的本地化标题；运行中 Zotero 若出现新颜色，没有名称就直接显示色值。
export const ANNOTATION_COLOR_LABEL_KEYS: Record<string, FluentMessageId> = {
  "#ffd400": "math-editor-color-yellow",
  "#ff6666": "math-editor-color-red",
  "#5fb236": "math-editor-color-green",
  "#2ea8e5": "math-editor-color-blue",
  "#a28ae5": "math-editor-color-purple",
  "#e56eee": "math-editor-color-magenta",
  "#f19837": "math-editor-color-orange",
  "#aaaaaa": "math-editor-color-gray",
  "#000000": "math-editor-color-black",
};
// 文本标注在 Zotero 里额外有黑色（EXTRA_INK_AND_TEXT_COLORS），阅读器右键
// 菜单把它排在 8 色之后；插件历史默认色也是黑色，所以同样追加在末尾。
const DEFAULT_ANNOTATION_COLOR = "#000000";
const ANNOTATION_COLOR_PREF = "lastAnnotationColor";

/**
 * 标注颜色统一成小写 6 位十六进制。Zotero 内置色和标注里可能出现的十六进制
 * 颜色都是这种形式；无效值返回 undefined，由调用方回退到默认色或上次用的颜色。
 */
export function normalizeAnnotationColor(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const digits = match[1];
  if (digits.length === 3) {
    return `#${[...digits].map((digit) => digit + digit).join("")}`;
  }
  return trimmed;
}

/**
 * 编辑器里的调色板：优先用运行中 Zotero 的标注调色板，保证和阅读器右键
 * 改色看到的一致；拿不到时退回内置的 8 色。文本标注再追加黑色（与 Zotero
 * 文本/墨迹标注的右键菜单一致，黑色排在最后）。
 */
export function getAnnotationColorPalette(): string[] {
  let palette: string[] = [];
  try {
    const annotations = (
      Zotero as unknown as {
        Annotations?: { COLORS?: unknown; DEFAULT_COLORS?: unknown };
      }
    ).Annotations;
    // Zotero 10 的 COLORS 是 [l10n key, hex] 对；旧版/其他分支是纯色值数组。
    const raw = annotations?.COLORS ?? annotations?.DEFAULT_COLORS;
    if (Array.isArray(raw)) {
      palette = raw
        .map((entry) => (Array.isArray(entry) ? entry[1] : entry))
        .map((color) => normalizeAnnotationColor(color))
        .filter((color): color is string => Boolean(color));
    }
  } catch (error) {
    logError("Unable to read Zotero annotation colors", error);
  }
  if (!palette.length) {
    palette = [...FALLBACK_ANNOTATION_COLORS];
  }
  return [...new Set([...palette, DEFAULT_ANNOTATION_COLOR])];
}

/** 新插入公式时使用的颜色：上次在编辑器里选过的颜色，没有则沿用黑色。 */
export function getPreferredAnnotationColor(): string {
  try {
    const stored = Zotero.Prefs.get(
      `${config.prefsPrefix}.${ANNOTATION_COLOR_PREF}`,
      true,
    );
    const normalized = normalizeAnnotationColor(stored);
    // 只接受当前调色板里的颜色：旧版本可能存过任意自定义色，现已不支持，
    // 继续沿用会让新插入的公式出现调色板里没有的颜色。
    if (normalized && getAnnotationColorPalette().includes(normalized)) {
      return normalized;
    }
    return DEFAULT_ANNOTATION_COLOR;
  } catch (error) {
    logError("Unable to read the saved annotation color", error);
    return DEFAULT_ANNOTATION_COLOR;
  }
}

/** 记住最后一次选择的颜色，供后续插入的新公式使用。 */
export function rememberAnnotationColor(color: string): void {
  const normalized = normalizeAnnotationColor(color);
  if (!normalized) {
    return;
  }
  try {
    Zotero.Prefs.set(
      `${config.prefsPrefix}.${ANNOTATION_COLOR_PREF}`,
      normalized,
      true,
    );
  } catch (error) {
    logError("Unable to save the annotation color", error);
  }
}
