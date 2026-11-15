/**
 * 关闭 reader 时的 runtime 清理：取消插入模式、移除工具栏监听与按钮、断开观察器、
 * 清定时器、移除注入的样式。
 */
import { STYLE_ID } from "./constants";
import { cancelMathInsertMode, getToolbarButtons } from "./insert";
import { logError } from "./log";
import { getRuntimeDocuments } from "./readerDocs";
import { state } from "./state";
import type { ReaderRuntime } from "./types";

export function disposeRuntime(runtime: ReaderRuntime): void {
  if (runtime.disposed) {
    return;
  }
  runtime.disposed = true;
  try {
    cancelMathInsertMode(runtime.reader);
  } catch (error) {
    logError("Unable to cancel math insert mode on dispose", error);
  }
  // 清理工具栏文档上的捕获监听与 Σ 按钮。禁用/卸载插件时 toolbar 文档可能
  // 仍存活（阅读器窗口还开着），不清理会残留闭包引用已 dispose 的实例。
  try {
    const toolbarDoc = state.readerDocs.get(runtime.reader);
    if (toolbarDoc) {
      for (const cleanup of state.toolbarDocCleanups.get(toolbarDoc) ?? []) {
        cleanup();
      }
      state.toolbarDocCleanups.delete(toolbarDoc);
    }
    const buttons = getToolbarButtons(runtime.reader);
    for (const button of buttons) {
      button.remove();
    }
    buttons.clear();
  } catch (error) {
    logError("Unable to clean up toolbar listeners", error);
  }
  for (const observer of runtime.observers) {
    observer.disconnect();
  }
  runtime.observers = [];
  for (const cleanup of runtime.documentCleanups) {
    cleanup();
  }
  runtime.documentCleanups = [];
  runtime.observedDocs.clear();
  try {
    runtime.win.removeEventListener("resize", runtime.resizeHandler);
    if (runtime.renderTimer) {
      runtime.win.clearTimeout(runtime.renderTimer);
    }
    if (runtime.repeatTimer) {
      runtime.win.clearTimeout(runtime.repeatTimer);
      runtime.repeatTimer = undefined;
    }
    if (runtime.syncRAF !== undefined) {
      runtime.win.cancelAnimationFrame(runtime.syncRAF);
      runtime.syncRAF = undefined;
    }
  } catch (error) {
    logError("Unable to clean up reader window listeners", error);
  }
  for (const doc of getRuntimeDocuments(runtime)) {
    doc.getElementById(STYLE_ID)?.remove();
  }
  state.runtimeSet.delete(runtime);
}
