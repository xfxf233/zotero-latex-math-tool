/**
 * reader 关闭时的 runtime 清理：取消插入模式、移除工具栏监听与按钮、断开观察器、
 * 清定时器、移除注入的样式；插件卸载时另外清掉页面上的 overlay 与原文隐藏状态。
 */
import {
  EDITOR_FRAME_CLASS,
  PAGE_OVERLAY_CLASS,
  RAW_HIDDEN_CLASS,
  STYLE_ID,
  TOOLBAR_STYLE_ID,
} from "./constants";
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
      runtime.renderTimer = undefined;
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
    doc.getElementById(TOOLBAR_STYLE_ID)?.remove();
  }
  state.runtimeSet.delete(runtime);
}

/**
 * 插件卸载时清掉页面上的插件产物：overlay 容器与原文隐藏类。
 *
 * 只由 `LatexMathTool.shutdown` 调用。正常 reader 关闭时文档马上销毁，不必再扫一遍；
 * 而插件禁用后 reader 仍开着，这些节点会失去样式、塌到页面角落，必须显式删除。
 */
export function removePageResidue(runtime: ReaderRuntime): void {
  for (const doc of getRuntimeDocuments(runtime)) {
    try {
      for (const overlay of doc.querySelectorAll(`.${PAGE_OVERLAY_CLASS}`)) {
        overlay.remove();
      }
      for (const hidden of doc.querySelectorAll(`.${RAW_HIDDEN_CLASS}`)) {
        hidden.classList.remove(RAW_HIDDEN_CLASS);
      }
      for (const editor of doc.querySelectorAll(
        `iframe.${EDITOR_FRAME_CLASS}`,
      )) {
        editor.remove();
      }
    } catch (error) {
      logError("Unable to remove page residue on shutdown", error);
    }
  }
}

/**
 * 插件卸载时的样式兜底：按仍打开的 reader 清工具栏文档里的样式。
 *
 * 覆盖"renderToolbar 已注入样式、runtime 还没建出来"的 reader——这类没有 runtime 可走，
 * 只能从 `state.readerDocs` 拿文档。
 */
export function removeToolbarStylesFromOpenReaders(): void {
  for (const reader of Zotero.Reader._readers ?? []) {
    try {
      state.readerDocs
        .get(reader as _ZoteroTypes.ReaderInstance<"pdf">)
        ?.getElementById(TOOLBAR_STYLE_ID)
        ?.remove();
    } catch (error) {
      logError("Unable to remove toolbar styles on shutdown", error);
    }
  }
}
