/**
 * Σ 按钮与"数学插入模式"。
 *
 * 负责往 PDF 阅读器工具栏注入按钮，并在按钮激活后接管点击、监视阅读器原生工具状态；
 * 用户落笔时用编辑器收集公式，再交给 annotations 模块写成标注。Zotero 原生文本工具
 * 抢先建出标注时，`captureNativeTextAnnotation` 是兜底入口。
 *
 * 本模块与 readerInit 互相需要（插入后要确保渲染 runtime，初始化又要 patch 标注
 * 管理器并回调本模块），因此 reader 初始化入口以回调形式注入，不直接 import。
 */
import { getString } from "../utils/locale";
import {
  getAnnotationFontSize,
  getAnnotationManager,
  parseAnnotationMath,
} from "./annotationData";
import {
  createAnnotationWithManager,
  updateManagerAnnotation,
} from "./annotations";
import {
  getPreferredAnnotationColor,
  normalizeAnnotationColor,
} from "./colors";
import { MATH_BASE_FONT_SIZE } from "./constants";
import { logToolbarPlacementDiagnostics } from "./diagnostics";
import { openEditorInDocument } from "./editor";
import { getClickLocationFromDocument } from "./geometry";
import { logError, showError } from "./log";
import { collectReaderDocuments } from "./readerDocs";
import { scheduleRender } from "./renderer";
import { state } from "./state";
import { injectToolbarStyles } from "./styles";
import {
  findLastAnnotationToolButton,
  getButtonLabel,
  isFreeTextToolLabel,
} from "./toolbarLabels";
import type { AnnotationManager, ReaderRuntime } from "./types";

type ReaderInitializer = (
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
) => Promise<ReaderRuntime>;

let readerInitializer: ReaderInitializer | undefined;

function ensureReaderReady(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
): Promise<ReaderRuntime> {
  if (!readerInitializer) {
    return Promise.reject(new Error("Reader initializer is not configured"));
  }
  return readerInitializer(reader);
}

/**
 * 注册 `renderToolbar` 监听：给每个 PDF reader 注入 Σ 按钮并触发渲染初始化。
 *
 * 由插件启动入口调用一次。`ensureReader` 通过参数传入，避免本模块与 readerInit 之间
 * 形成 import 环（初始化会 patch 管理器，patch 后又要回调 captureNativeTextAnnotation）。
 */
export function startToolbarIntegration(
  ensureReaderFn: ReaderInitializer,
): void {
  readerInitializer = ensureReaderFn;
  state.toolbarHandler = (event) => {
    if (event.reader.type !== "pdf") {
      return;
    }

    const reader = event.reader as _ZoteroTypes.ReaderInstance<"pdf">;
    appendToolbarButton(event, reader);
    ensureReaderFn(reader).catch((error) =>
      logError("Unable to initialize reader", error),
    );
  };

  Zotero.Reader.registerEventListener(
    "renderToolbar",
    state.toolbarHandler,
    addon.data.config.addonID,
  );
}

/** 注销 `renderToolbar` 监听。插件 shutdown 时调用，保证工具栏不再回调已卸载状态。 */
export function stopToolbarIntegration(): void {
  if (state.toolbarHandler) {
    Zotero.Reader.unregisterEventListener(
      "renderToolbar",
      state.toolbarHandler,
    );
    state.toolbarHandler = undefined;
  }
}

function appendToolbarButton(
  event: _ZoteroTypes.Reader.EventParams<"renderToolbar">,
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
): void {
  state.readerDocs.set(reader, event.doc);
  injectToolbarStyles(event.doc);
  watchToolbarDocument(reader, event.doc);

  // `renderToolbar` can fire more than once per reader (toolbar re-renders);
  // reuse the existing button instead of stacking duplicates.
  const existing = event.doc.querySelector<HTMLButtonElement>(
    ".zotero-latex-math-toolbar-button",
  );
  if (existing?.isConnected) {
    getToolbarButtons(reader).add(existing);
    return;
  }

  const button = event.doc.createElement("button");
  button.type = "button";
  button.className = "toolbar-button zotero-latex-math-toolbar-button";
  button.title = getString("math-tool-insert-tooltip");
  button.setAttribute("aria-label", getString("math-tool-insert-tooltip"));
  button.setAttribute("aria-pressed", "false");
  button.textContent = "\u03a3";
  button.style.minWidth = "32px";
  button.style.fontSize = "18px";
  button.style.fontWeight = "700";
  button.addEventListener("click", async () => {
    // Toggle-off must win immediately: while math mode is armed, clicking Σ
    // again cancels it. The button is never disabled, so a rapid second click
    // cannot be swallowed by an in-flight activation.
    if (state.nativeTextInsertReaders.has(reader)) {
      cancelMathInsertMode(reader);
      return;
    }
    if (state.activatingReaders.has(reader)) {
      return;
    }
    state.activatingReaders.add(reader);
    try {
      setToolbarButtonsActive(reader, true);
      await activateNativeTextInsertMode(reader);
    } catch (error) {
      // 激活失败必须完整回滚：若激活中途抛错（如 PDF 页面文档尚未就绪、
      // 找不到 .page 元素），`nativeTextInsertReaders` 标志会残留，之后用户
      // 用原生"添加文字"工具时会被误判为数学插入而劫持弹编辑器。
      // `cancelMathInsertMode` 幂等，可安全重复调用。
      cancelMathInsertMode(reader);
      setToolbarButtonsActive(reader, false);
      logError("Unable to activate LaTeX insert mode", error);
      showError(reader, getString("math-tool-activate-error"));
    } finally {
      state.activatingReaders.delete(reader);
    }
  });
  getToolbarButtons(reader).add(button);
  event.append(button);
  event.doc.defaultView?.requestAnimationFrame(() =>
    relocateToolbarButton(button, event.doc),
  );
}

function watchToolbarDocument(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  doc: Document,
): void {
  if (state.watchedToolbarDocs.has(doc)) {
    return;
  }
  state.watchedToolbarDocs.add(doc);

  // Zotero's toolbar may activate a tool on `pointerdown`/`mousedown` and
  // suppress the resulting `click`, so a click-only listener would miss the
  // switch and leave math insert mode armed. Listen on all three; the checks
  // are cheap and `cancelMathInsertMode` is idempotent.
  const cancelOnToolbarAction = (event: Event) => {
    const target = event.target as Element | null;
    const button = target?.closest(
      'button,[role="button"],toolbarbutton',
    ) as HTMLElement | null;
    if (
      !button ||
      button.classList.contains("zotero-latex-math-toolbar-button")
    ) {
      return;
    }

    // Preserve the native tool: the user's click will select it, so math
    // insert mode must not reset the reader back to the pointer tool.
    cancelMathInsertMode(reader, { preserveNativeTool: true });
  };

  const cleanups: Array<() => void> = [];
  for (const eventName of ["pointerdown", "mousedown", "click"]) {
    doc.addEventListener(eventName, cancelOnToolbarAction, true);
    cleanups.push(() => {
      doc.removeEventListener(eventName, cancelOnToolbarAction, true);
    });
  }
  state.toolbarDocCleanups.set(doc, cleanups);
}

export function getToolbarButtons(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
): Set<HTMLButtonElement> {
  let buttons = state.toolbarButtons.get(reader);
  if (!buttons) {
    buttons = new Set();
    state.toolbarButtons.set(reader, buttons);
  }
  return buttons;
}

function setToolbarButtonsActive(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  active: boolean,
): void {
  for (const button of getToolbarButtons(reader)) {
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

async function activateNativeTextInsertMode(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
): Promise<void> {
  await reader._waitForReader?.();
  const manager = getAnnotationManager(reader);
  if (!manager?.addAnnotation) {
    throw new Error("Reader annotation manager is not available");
  }

  cancelMathInsertMode(reader);
  state.nativeTextInsertReaders.add(reader);
  setToolbarButtonsActive(reader, true);
  setNativeTool(reader, { type: "pointer" });
  installDirectPDFClickHandlers(reader, manager);
  startToolMonitor(reader);

  ensureReaderReady(reader).catch((error) =>
    logError("Unable to initialize renderer after text tool activation", error),
  );
}

export function cancelMathInsertMode(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  options?: { preserveNativeTool?: boolean },
): void {
  stopToolMonitor(reader);
  for (const cleanup of state.directInsertCleanups.get(reader) ?? []) {
    cleanup();
  }
  state.directInsertCleanups.delete(reader);

  if (!state.nativeTextInsertReaders.has(reader)) {
    setToolbarButtonsActive(reader, false);
    return;
  }

  state.nativeTextInsertReaders.delete(reader);
  setToolbarButtonsActive(reader, false);
  // When the user switched to another native tool on their own, keep their
  // selection instead of forcing the pointer tool back.
  if (!options?.preserveNativeTool) {
    setNativeTool(reader, { type: "pointer" });
  }
}

/**
 * While math insert mode is armed the reader's native tool is kept at
 * `pointer`. If the user picks another tool (toolbar click missed by the
 * document listeners, keyboard shortcut, context menu, …) `_state.tool`
 * changes and math mode must be abandoned so a later PDF click doesn't open
 * the LaTeX editor. Runs only while math mode is active, so it is off the
 * render path entirely.
 *
 * The first tick captures the settled tool state as the baseline instead of
 * assuming `pointer`: if Zotero's `setTool` does not synchronise `_state.tool`
 * the moment math mode arms, comparing against a hard-coded `pointer` would
 * cancel math mode immediately and break insertion. Only a *change* away from
 * the baseline counts as the user switching tools.
 */
function startToolMonitor(reader: _ZoteroTypes.ReaderInstance<"pdf">): void {
  stopToolMonitor(reader);
  const runtime = state.runtimes.get(reader);
  if (!runtime || runtime.disposed) {
    return;
  }
  let baseline: string | undefined;
  let deviationTicks = 0;
  runtime.toolMonitorTimer = runtime.win.setInterval(() => {
    if (runtime.disposed || !state.nativeTextInsertReaders.has(reader)) {
      stopToolMonitor(reader);
      return;
    }
    const current = getCurrentToolType(reader);
    if (baseline === undefined) {
      baseline = current;
      state.mathModeBaselineTools.set(reader, current);
      return;
    }
    // Require two consecutive deviated ticks (~400ms) before cancelling:
    // Zotero can transiently reset the tool (e.g. while an annotation editor
    // initialises) and a single tick would cancel math mode for no reason.
    if (current !== baseline) {
      deviationTicks += 1;
      if (deviationTicks >= 2) {
        cancelMathInsertMode(reader, { preserveNativeTool: true });
      }
    } else {
      deviationTicks = 0;
    }
  }, 200);
}

function stopToolMonitor(reader: _ZoteroTypes.ReaderInstance<"pdf">): void {
  state.mathModeBaselineTools.delete(reader);
  const runtime = state.runtimes.get(reader);
  if (!runtime || runtime.toolMonitorTimer === undefined) {
    return;
  }
  runtime.win.clearInterval(runtime.toolMonitorTimer);
  runtime.toolMonitorTimer = undefined;
}

function getCurrentToolType(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
): string | undefined {
  const internalReader = (reader as any)._internalReader as any;
  return internalReader?._state?.tool?.type;
}

function installDirectPDFClickHandlers(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  manager: AnnotationManager,
): void {
  const docs = collectReaderDocuments(reader).filter((doc) =>
    doc.querySelector(".page"),
  );
  if (!docs.length) {
    throw new Error("Unable to find PDF page document");
  }
  const cleanups: Array<() => void> = [];
  let handled = false;

  const handler = (event: Event) => {
    if (handled || !state.nativeTextInsertReaders.has(reader)) {
      return;
    }

    // If the user has already switched to another native annotation tool,
    // abandon the pending math insert and let that tool handle this click
    // instead of opening the LaTeX editor. This closes the race window where
    // the tool-monitor tick hasn't fired yet. The baseline is undefined until
    // the monitor's first tick, in which case we skip the check rather than
    // risk cancelling on a tool state that has not settled yet.
    const baseline = state.mathModeBaselineTools.get(reader);
    if (baseline !== undefined && getCurrentToolType(reader) !== baseline) {
      cancelMathInsertMode(reader, { preserveNativeTool: true });
      return;
    }

    const mouseEvent = event as MouseEvent;
    const doc = (event.currentTarget as Document | null) ?? undefined;
    if (!doc) {
      return;
    }

    const location = getClickLocationFromDocument(reader, doc, mouseEvent);
    if (!location) {
      return;
    }

    handled = true;
    event.preventDefault();
    event.stopPropagation();
    cancelMathInsertMode(reader);

    void openEditorInDocument(state.readerDocs.get(reader) ?? doc, {
      initialSource: "",
      isNew: true,
      baseFontSize: MATH_BASE_FONT_SIZE,
      initialColor: getPreferredAnnotationColor(),
      applyInitialColorOnSave: true,
      title: getString("math-editor-insert-title"),
      onSave: async (source, renderedSize, color) => {
        await createAnnotationWithManager(
          reader,
          manager,
          location,
          source,
          doc,
          MATH_BASE_FONT_SIZE,
          renderedSize,
          color,
        );
        ensureReaderReady(reader)
          .then((runtime) => scheduleRender(runtime.reader, true))
          .catch((error) =>
            logError("Unable to refresh rendered math annotation", error),
          );
      },
    });
  };

  for (const doc of docs) {
    doc.addEventListener("pointerup", handler, true);
    doc.addEventListener("click", handler, true);
    cleanups.push(() => {
      doc.removeEventListener("pointerup", handler, true);
      doc.removeEventListener("click", handler, true);
    });
  }

  state.directInsertCleanups.set(reader, cleanups);
}

export function captureNativeTextAnnotation(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  annotation?: _ZoteroTypes.Reader.Annotation | null,
): boolean {
  if (
    !annotation ||
    annotation.type !== "text" ||
    !state.nativeTextInsertReaders.has(reader) ||
    parseAnnotationMath(annotation)
  ) {
    return false;
  }

  state.nativeTextInsertReaders.delete(reader);
  stopToolMonitor(reader);
  setToolbarButtonsActive(reader, false);
  setNativeTool(reader, { type: "pointer" });
  void completeNativeMathAnnotation(reader, annotation);
  return true;
}

async function completeNativeMathAnnotation(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  annotation: _ZoteroTypes.Reader.Annotation,
): Promise<void> {
  const doc = state.readerDocs.get(reader) ?? reader._iframeWindow?.document;
  if (!doc) {
    return;
  }

  const baseFontSize = getAnnotationFontSize(annotation);
  await openEditorInDocument(doc, {
    initialSource: "",
    isNew: true,
    baseFontSize,
    // 这条兜底路径下标注已由 Zotero 创建，尊重它当前的颜色（通常来自
    // Zotero 自己的标注调色板）；只有颜色缺失时才用上次记住的颜色。
    initialColor:
      normalizeAnnotationColor(annotation.color) ??
      getPreferredAnnotationColor(),
    title: getString("math-editor-insert-title"),
    onSave: async (source, renderedSize, color) => {
      await updateManagerAnnotation(
        reader,
        annotation,
        source,
        doc,
        baseFontSize,
        renderedSize,
        color,
      );
      ensureReaderReady(reader)
        .then((runtime) => {
          scheduleRender(runtime.reader, true);
        })
        .catch((error) =>
          logError("Unable to refresh rendered math annotation", error),
        );
    },
  });
}

function relocateToolbarButton(button: HTMLButtonElement, doc: Document): void {
  // rAF 可能在 dispose（按钮已移除）后才执行；已断开连接的按钮直接跳过，
  // 避免被重新插回工具栏。
  if (!button.isConnected) {
    return;
  }
  const nativeButtons = [
    ...doc.querySelectorAll<HTMLElement>(
      'button,[role="button"],toolbarbutton',
    ),
  ].filter((candidate) => candidate !== button);

  if (__env__ === "development") {
    logToolbarPlacementDiagnostics(nativeButtons);
  }

  const textButton =
    nativeButtons.find((candidate) =>
      isFreeTextToolLabel(getButtonLabel(candidate)),
    ) ?? findLastAnnotationToolButton(nativeButtons);

  const targetParent = textButton?.parentElement;
  if (!textButton || !targetParent || targetParent === button.parentElement) {
    if (textButton?.nextSibling && textButton.parentElement) {
      textButton.parentElement.insertBefore(button, textButton.nextSibling);
    }
    return;
  }

  targetParent.insertBefore(button, textButton.nextSibling);
}

function setNativeTool(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  tool: { type: string; color?: string },
): void {
  const internalReader = reader._internalReader as any;
  // Always write `_state.tool` directly: if `internalReader.setTool` exists
  // but does not synchronise `_state.tool`, the previously-selected native
  // tool would keep its toolbar highlight and math mode would look like it is
  // selected alongside the native tool. Setting the source of truth up front
  // guarantees the state; the method calls below still give Zotero's own
  // plumbing a chance to propagate the change to the toolbar/views.
  if (internalReader?._state) {
    internalReader._state.tool = tool;
  }
  if (typeof internalReader?.setTool === "function") {
    internalReader.setTool(tool);
  }
  const primaryView = internalReader?._primaryView as any;
  if (typeof primaryView?.setTool === "function") {
    primaryView.setTool(tool);
  }
}
