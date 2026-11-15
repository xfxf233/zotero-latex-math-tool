/**
 * 通用纯函数：数值裁剪、HTML/CSS 转义、跨 realm 数值数组复制。
 *
 * 不依赖插件状态；渲染、编辑器、诊断共用。
 */

export function toPlainNumberArray(values: ArrayLike<number>): number[] {
  return Array.from({ length: values.length }, (_value, index) =>
    Number(values[index]),
  );
}

export function normalizeRect(rect: number[]): number[] {
  return [
    Math.min(rect[0], rect[2]),
    Math.min(rect[1], rect[3]),
    Math.max(rect[0], rect[2]),
    Math.max(rect[1], rect[3]),
  ];
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function escapeHTML(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function escapeCSSAttributeValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.stack || error.name;
  }
  if (error && typeof error === "object") {
    const entries = Object.getOwnPropertyNames(error).map(
      (key) => `${key}: ${String((error as Record<string, unknown>)[key])}`,
    );
    if (entries.length) {
      return entries.join("\n");
    }
  }
  try {
    const json = JSON.stringify(error);
    return json && json !== "{}" ? json : String(error);
  } catch {
    return String(error);
  }
}
