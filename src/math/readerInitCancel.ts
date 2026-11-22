/**
 * 初始化取消的约定：插件 shutdown 或 reader 关闭时，in-flight 的 `ensureReader` 以
 * `ReaderInitCancelled` 结束。
 *
 * 取消是常规路径（用户关掉一个正在加载的 PDF、或恰好此时禁用插件），调用方用
 * `logReaderInitError` 跳过日志；其余错误照旧上报。独立成模块是为了让 insert /
 * mathTool 导入判定，而不引入 readerInit → patches → insert 的循环。
 */
import { logError } from "./log";

export class ReaderInitCancelled extends Error {
  constructor() {
    super("Reader initialization was cancelled");
    this.name = "ReaderInitCancelled";
  }
}

export function logReaderInitError(message: string, error: unknown): void {
  if (error instanceof ReaderInitCancelled) {
    return;
  }
  logError(message, error);
}
