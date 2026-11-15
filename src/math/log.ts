/**
 * 统一的错误日志（Zotero.debug）与用户可见错误提示。
 */
import { stringifyError } from "./util";

export function logError(message: string, error: unknown): void {
  Zotero.debug(`[LaTeX Math Tool] ${message}: ${stringifyError(error)}`);
}

export function showError(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  message: string,
): void {
  const win = reader._iframeWindow ?? Zotero.getMainWindow();
  win?.alert?.(message);
}
