import katexStyles from "katex/dist/katex.min.css";
import { renderToString } from "katex";
import { katexFontURLs } from "./katexFonts";
import toolStyles from "./styles.css";
import { getString } from "./utils/locale";

type MathMode = "display" | "inline";

type MathPayload = {
  mode: MathMode;
  latex: string;
  encoded: string;
  renderedSize?: FormulaSize;
};

type ClickLocation = {
  pageIndex: number;
  rect: number[];
};

type FormulaSize = {
  width: number;
  height: number;
};

type Viewport = {
  convertToPdfPoint?: (x: number, y: number) => number[];
  convertToViewportRectangle?: (rect: number[]) => number[];
  width?: number;
  height?: number;
};

type ViewportRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type ReaderRuntime = {
  reader: _ZoteroTypes.ReaderInstance<"pdf">;
  win: Window;
  doc: Document;
  observers: MutationObserver[];
  observedDocs: Set<Document>;
  documentCleanups: Array<() => void>;
  resizeHandler: EventListener;
  renderTimer?: number;
  toolMonitorTimer?: number;
  lastScale?: number;
  syncRAF?: number;
  disposed: boolean;
};

type AnnotationManager = _ZoteroTypes.Reader.AnnotationManager & {
  _getAnnotationByID?: (id: string) => _ZoteroTypes.Reader.Annotation;
  _save?: (
    annotation: _ZoteroTypes.Reader.Annotation,
    instant?: boolean,
  ) => void;
};

const DISPLAY_PREFIX = "[[math:display]]";
const INLINE_PREFIX = "[[math:inline]]";
const STYLE_ID = "zotero-latex-math-tool-styles";
const TOOLBAR_STYLE_ID = "zotero-latex-math-tool-toolbar-styles";
const MANAGER_RENDER_CLASS = "zotero-latex-math-manager-render";
const PAGE_OVERLAY_CLASS = "zotero-latex-math-page-overlay";
const RAW_HIDDEN_CLASS = "zotero-latex-math-raw-hidden";
const FIT_CONTENT_CLASS = "zotero-latex-math-fit-content";

export class LatexMathTool {
  private toolbarHandler?: _ZoteroTypes.Reader.EventHandler<"renderToolbar">;
  private runtimes = new WeakMap<_ZoteroTypes.ReaderInstance, ReaderRuntime>();
  private toolbarButtons = new WeakMap<
    _ZoteroTypes.ReaderInstance,
    Set<HTMLButtonElement>
  >();
  private readerDocs = new WeakMap<_ZoteroTypes.ReaderInstance, Document>();
  private watchedToolbarDocs = new WeakSet<Document>();
  private nativeTextInsertReaders = new WeakSet<_ZoteroTypes.ReaderInstance>();
  private activatingReaders = new WeakSet<_ZoteroTypes.ReaderInstance>();
  private directInsertCleanups = new WeakMap<
    _ZoteroTypes.ReaderInstance,
    Array<() => void>
  >();
  private patchedManagers = new WeakSet<AnnotationManager>();
  private patchedReaders = new WeakSet<_ZoteroTypes.ReaderInstance>();
  private runtimeSet = new Set<ReaderRuntime>();
  private lastRenderDiagnostics = new WeakMap<
    _ZoteroTypes.ReaderInstance,
    string
  >();
  private mathAnnotationCache = new WeakMap<
    _ZoteroTypes.ReaderInstance,
    boolean
  >();
  private mathAnnotationCacheCounts = new WeakMap<
    _ZoteroTypes.ReaderInstance,
    number
  >();
  private mathModeBaselineTools = new WeakMap<
    _ZoteroTypes.ReaderInstance,
    string | undefined
  >();

  public startup(): void {
    this.toolbarHandler = (event) => {
      if (event.reader.type !== "pdf") {
        return;
      }

      const reader = event.reader as _ZoteroTypes.ReaderInstance<"pdf">;
      this.appendToolbarButton(event, reader);
      this.ensureReader(reader).catch((error) =>
        this.logError("Unable to initialize reader", error),
      );
    };

    Zotero.Reader.registerEventListener(
      "renderToolbar",
      this.toolbarHandler,
      addon.data.config.addonID,
    );

    for (const reader of Zotero.Reader._readers ?? []) {
      if (reader.type === "pdf") {
        void this.ensureReader(reader as _ZoteroTypes.ReaderInstance<"pdf">);
      }
    }
  }

  public shutdown(): void {
    if (this.toolbarHandler) {
      Zotero.Reader.unregisterEventListener(
        "renderToolbar",
        this.toolbarHandler,
      );
      this.toolbarHandler = undefined;
    }

    for (const runtime of [...this.runtimeSet]) {
      this.disposeRuntime(runtime);
    }
    this.runtimeSet.clear();
  }

  public disposeWindow(win: Window): void {
    for (const runtime of [...this.runtimeSet]) {
      const readerWindow = runtime.reader._window;
      if (
        win === readerWindow ||
        win === runtime.win ||
        win === runtime.win.top
      ) {
        this.disposeRuntime(runtime);
      }
    }
  }

  private async ensureReader(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
  ): Promise<ReaderRuntime> {
    const existing = this.runtimes.get(reader);
    if (
      existing &&
      !existing.disposed &&
      !Components.utils.isDeadWrapper(existing.win)
    ) {
      return existing;
    }

    await reader._waitForReader?.();
    const primaryView = reader._internalReader?._primaryView;
    await primaryView?.initializedPromise?.catch(() => undefined);

    const win = await this.waitForPDFWindow(reader);
    if (!win?.document?.body) {
      throw new Error("PDF iframe window is not ready");
    }

    const manager = this.getAnnotationManager(reader);
    if (manager) {
      this.patchAnnotationManager(reader, manager);
    }

    const resizeHandler = () => this.scheduleRender(reader);
    win.addEventListener("resize", resizeHandler);

    const runtime: ReaderRuntime = {
      reader,
      win,
      doc: win.document,
      observers: [],
      observedDocs: new Set(),
      documentCleanups: [],
      resizeHandler,
      disposed: false,
    };

    this.runtimes.set(reader, runtime);
    this.runtimeSet.add(runtime);
    this.patchReaderUninit(reader);
    this.ensureAnnotationMetadata(reader);
    this.refreshObservedDocuments(runtime);
    this.scheduleRender(reader);

    return runtime;
  }

  private appendToolbarButton(
    event: _ZoteroTypes.Reader.EventParams<"renderToolbar">,
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
  ): void {
    this.readerDocs.set(reader, event.doc);
    this.injectToolbarStyles(event.doc);
    this.watchToolbarDocument(reader, event.doc);

    // `renderToolbar` can fire more than once per reader (toolbar re-renders);
    // reuse the existing button instead of stacking duplicates.
    const existing = event.doc.querySelector<HTMLButtonElement>(
      ".zotero-latex-math-toolbar-button",
    );
    if (existing?.isConnected) {
      this.getToolbarButtons(reader).add(existing);
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
      if (this.nativeTextInsertReaders.has(reader)) {
        this.cancelMathInsertMode(reader);
        return;
      }
      if (this.activatingReaders.has(reader)) {
        return;
      }
      this.activatingReaders.add(reader);
      try {
        this.setToolbarButtonsActive(reader, true);
        await this.activateNativeTextInsertMode(reader);
      } catch (error) {
        this.setToolbarButtonsActive(reader, false);
        this.logError("Unable to activate LaTeX insert mode", error);
        this.showError(reader, getString("math-tool-activate-error"));
      } finally {
        this.activatingReaders.delete(reader);
      }
    });
    this.getToolbarButtons(reader).add(button);
    event.append(button);
    event.doc.defaultView?.requestAnimationFrame(() =>
      this.relocateToolbarButton(button, event.doc),
    );
  }

  private watchToolbarDocument(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    doc: Document,
  ): void {
    if (this.watchedToolbarDocs.has(doc)) {
      return;
    }
    this.watchedToolbarDocs.add(doc);

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
      this.cancelMathInsertMode(reader, { preserveNativeTool: true });
    };

    for (const eventName of ["pointerdown", "mousedown", "click"]) {
      doc.addEventListener(eventName, cancelOnToolbarAction, true);
    }
  }

  private getToolbarButtons(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
  ): Set<HTMLButtonElement> {
    let buttons = this.toolbarButtons.get(reader);
    if (!buttons) {
      buttons = new Set();
      this.toolbarButtons.set(reader, buttons);
    }
    return buttons;
  }

  private setToolbarButtonsActive(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    active: boolean,
  ): void {
    for (const button of this.getToolbarButtons(reader)) {
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

  private async activateNativeTextInsertMode(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
  ): Promise<void> {
    await reader._waitForReader?.();
    const manager = this.getAnnotationManager(reader);
    if (!manager?.addAnnotation) {
      throw new Error("Reader annotation manager is not available");
    }

    this.cancelMathInsertMode(reader);
    this.nativeTextInsertReaders.add(reader);
    this.setToolbarButtonsActive(reader, true);
    this.setNativeTool(reader, { type: "pointer" });
    this.installDirectPDFClickHandlers(reader, manager);
    this.startToolMonitor(reader);

    this.ensureReader(reader).catch((error) =>
      this.logError(
        "Unable to initialize renderer after text tool activation",
        error,
      ),
    );
  }

  private cancelMathInsertMode(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    options?: { preserveNativeTool?: boolean },
  ): void {
    this.stopToolMonitor(reader);
    for (const cleanup of this.directInsertCleanups.get(reader) ?? []) {
      cleanup();
    }
    this.directInsertCleanups.delete(reader);

    if (!this.nativeTextInsertReaders.has(reader)) {
      this.setToolbarButtonsActive(reader, false);
      return;
    }

    this.nativeTextInsertReaders.delete(reader);
    this.setToolbarButtonsActive(reader, false);
    // When the user switched to another native tool on their own, keep their
    // selection instead of forcing the pointer tool back.
    if (!options?.preserveNativeTool) {
      this.setNativeTool(reader, { type: "pointer" });
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
  private startToolMonitor(reader: _ZoteroTypes.ReaderInstance<"pdf">): void {
    this.stopToolMonitor(reader);
    const runtime = this.runtimes.get(reader);
    if (!runtime || runtime.disposed) {
      return;
    }
    let baseline: string | undefined;
    let deviationTicks = 0;
    runtime.toolMonitorTimer = runtime.win.setInterval(() => {
      if (runtime.disposed || !this.nativeTextInsertReaders.has(reader)) {
        this.stopToolMonitor(reader);
        return;
      }
      const current = this.getCurrentToolType(reader);
      if (baseline === undefined) {
        baseline = current;
        this.mathModeBaselineTools.set(reader, current);
        return;
      }
      // Require two consecutive deviated ticks (~400ms) before cancelling:
      // Zotero can transiently reset the tool (e.g. while an annotation editor
      // initialises) and a single tick would cancel math mode for no reason.
      if (current !== baseline) {
        deviationTicks += 1;
        if (deviationTicks >= 2) {
          this.cancelMathInsertMode(reader, { preserveNativeTool: true });
        }
      } else {
        deviationTicks = 0;
      }
    }, 200);
  }

  private stopToolMonitor(reader: _ZoteroTypes.ReaderInstance<"pdf">): void {
    this.mathModeBaselineTools.delete(reader);
    const runtime = this.runtimes.get(reader);
    if (!runtime || runtime.toolMonitorTimer === undefined) {
      return;
    }
    runtime.win.clearInterval(runtime.toolMonitorTimer);
    runtime.toolMonitorTimer = undefined;
  }

  private getCurrentToolType(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
  ): string | undefined {
    const internalReader = (reader as any)._internalReader as any;
    return internalReader?._state?.tool?.type;
  }

  private installDirectPDFClickHandlers(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    manager: AnnotationManager,
  ): void {
    const docs = this.collectReaderDocuments(reader).filter((doc) =>
      doc.querySelector(".page"),
    );
    if (!docs.length) {
      throw new Error("Unable to find PDF page document");
    }
    const cleanups: Array<() => void> = [];
    let handled = false;

    const handler = (event: Event) => {
      if (handled || !this.nativeTextInsertReaders.has(reader)) {
        return;
      }

      // If the user has already switched to another native annotation tool,
      // abandon the pending math insert and let that tool handle this click
      // instead of opening the LaTeX editor. This closes the race window where
      // the tool-monitor tick hasn't fired yet. The baseline is undefined until
      // the monitor's first tick, in which case we skip the check rather than
      // risk cancelling on a tool state that has not settled yet.
      const baseline = this.mathModeBaselineTools.get(reader);
      if (
        baseline !== undefined &&
        this.getCurrentToolType(reader) !== baseline
      ) {
        this.cancelMathInsertMode(reader, { preserveNativeTool: true });
        return;
      }

      const mouseEvent = event as MouseEvent;
      const doc = (event.currentTarget as Document | null) ?? undefined;
      if (!doc) {
        return;
      }

      const location = this.getClickLocationFromDocument(
        reader,
        doc,
        mouseEvent,
      );
      if (!location) {
        return;
      }

      handled = true;
      event.preventDefault();
      event.stopPropagation();
      this.cancelMathInsertMode(reader);

      void this.openEditorInDocument(this.readerDocs.get(reader) ?? doc, {
        initial: { latex: "", mode: "display" },
        title: getString("math-editor-insert-title"),
        onSave: async (payload) => {
          await this.createAnnotationWithManager(
            reader,
            manager,
            location,
            payload,
            doc,
          );
          this.ensureReader(reader)
            .then((runtime) => this.scheduleRender(runtime.reader, true))
            .catch((error) =>
              this.logError(
                "Unable to refresh rendered math annotation",
                error,
              ),
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

    this.directInsertCleanups.set(reader, cleanups);
  }

  private collectReaderDocuments(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
  ): Document[] {
    const readerAny = reader as any;
    const docs = [
      this.readerDocs.get(reader),
      readerAny._iframeWindow?.document,
      readerAny._iframe?.contentDocument,
      readerAny._internalReader?._primaryView?._iframeWindow?.document,
      readerAny._internalReader?._primaryView?._iframe?.contentDocument,
    ].filter((doc): doc is Document => Boolean(doc?.body));

    const nestedDocs = docs.flatMap((doc) =>
      this.getNestedFrameWindows(doc).map((win) => win.document),
    );

    return [...new Set([...docs, ...nestedDocs])];
  }

  private patchAnnotationManager(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    manager: AnnotationManager,
  ): void {
    if (this.patchedManagers.has(manager)) {
      return;
    }

    const originalAddAnnotation = manager.addAnnotation.bind(manager);
    manager.addAnnotation = ((
      annotation: Parameters<typeof manager.addAnnotation>[0],
    ) => {
      const created = originalAddAnnotation(annotation);
      this.captureNativeTextAnnotation(reader, created);
      return created;
    }) as typeof manager.addAnnotation;

    const originalUpdateAnnotations = manager.updateAnnotations?.bind(manager);
    if (originalUpdateAnnotations) {
      manager.updateAnnotations = ((
        annotations: _ZoteroTypes.Reader.Annotation[],
      ) => {
        for (const annotation of annotations) {
          this.captureNativeTextAnnotation(reader, annotation);
        }
        this.ensureAnnotationMetadata(reader);
        const result = originalUpdateAnnotations(annotations);
        if (this.hasMathAnnotation(annotations)) {
          this.scheduleRender(reader, true);
        }
        return result;
      }) as typeof manager.updateAnnotations;
    }

    const originalSetAnnotations = manager.setAnnotations?.bind(manager);
    if (originalSetAnnotations) {
      manager.setAnnotations = (async (
        annotations: _ZoteroTypes.Reader.Annotation[],
      ) => {
        const result = await originalSetAnnotations(annotations);
        for (const annotation of manager._annotations ?? annotations) {
          this.captureNativeTextAnnotation(reader, annotation);
        }
        this.ensureAnnotationMetadata(reader);
        if (this.hasMathAnnotation(manager._annotations ?? annotations)) {
          this.scheduleRender(reader, true);
        }
        return result;
      }) as typeof manager.setAnnotations;
    }

    const originalSave = manager._save?.bind(manager);
    if (originalSave) {
      manager._save = ((
        annotation: _ZoteroTypes.Reader.Annotation,
        instant?: boolean,
      ) => {
        this.captureNativeTextAnnotation(reader, annotation);
        const result = originalSave(annotation, instant);
        if (this.hasMathAnnotation([annotation])) {
          this.scheduleRender(reader, true);
        }
        return result;
      }) as typeof manager._save;
    }

    this.patchedManagers.add(manager);
  }

  /**
   * Dispose the runtime when Zotero tears the reader down.
   *
   * `uninit()` is the common teardown path for both reader tabs and reader
   * windows (see Zotero's `ReaderTab.close()` / `ReaderWindow.close()`), so
   * wrapping it guarantees the MutationObservers and window listeners held by
   * the runtime are released when a PDF tab is closed — not just when the whole
   * plugin or window shuts down.
   */
  private patchReaderUninit(reader: _ZoteroTypes.ReaderInstance<"pdf">): void {
    if (this.patchedReaders.has(reader)) {
      return;
    }
    this.patchedReaders.add(reader);

    const originalUninit = reader.uninit?.bind(reader);
    if (!originalUninit) {
      return;
    }

    reader.uninit = () => {
      try {
        const runtime = this.runtimes.get(reader);
        if (runtime) {
          this.disposeRuntime(runtime);
        }
      } catch (error) {
        this.logError("Unable to dispose reader runtime", error);
      }
      return originalUninit();
    };
  }

  private hasMathAnnotation(
    annotations: _ZoteroTypes.Reader.Annotation[] | undefined,
  ): boolean {
    return Boolean(
      annotations?.some((annotation) =>
        this.parsePayload(annotation.text ?? annotation.comment ?? ""),
      ),
    );
  }

  private captureNativeTextAnnotation(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    annotation?: _ZoteroTypes.Reader.Annotation | null,
  ): boolean {
    if (
      !annotation ||
      annotation.type !== "text" ||
      !this.nativeTextInsertReaders.has(reader) ||
      this.parsePayload(annotation.text ?? "")
    ) {
      return false;
    }

    this.nativeTextInsertReaders.delete(reader);
    this.stopToolMonitor(reader);
    this.setToolbarButtonsActive(reader, false);
    this.setNativeTool(reader, { type: "pointer" });
    void this.completeNativeMathAnnotation(reader, annotation);
    return true;
  }

  private async completeNativeMathAnnotation(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    annotation: _ZoteroTypes.Reader.Annotation,
  ): Promise<void> {
    const doc = this.readerDocs.get(reader) ?? reader._iframeWindow?.document;
    if (!doc) {
      return;
    }

    await this.openEditorInDocument(doc, {
      initial: { latex: "", mode: "display" },
      title: getString("math-editor-insert-title"),
      onSave: async (payload) => {
        await this.updateManagerAnnotation(reader, annotation, payload, doc);
        this.ensureReader(reader)
          .then((runtime) => {
            this.scheduleRender(runtime.reader, true);
          })
          .catch((error) =>
            this.logError("Unable to refresh rendered math annotation", error),
          );
      },
    });
  }

  private relocateToolbarButton(
    button: HTMLButtonElement,
    doc: Document,
  ): void {
    const nativeButtons = [
      ...doc.querySelectorAll<HTMLElement>(
        'button,[role="button"],toolbarbutton',
      ),
    ].filter((candidate) => candidate !== button);

    const textButton =
      nativeButtons.find((candidate) =>
        this.isFreeTextToolLabel(this.getButtonLabel(candidate)),
      ) ?? this.findLastAnnotationToolButton(nativeButtons);

    const targetParent = textButton?.parentElement;
    if (!textButton || !targetParent || targetParent === button.parentElement) {
      if (textButton?.nextSibling && textButton.parentElement) {
        textButton.parentElement.insertBefore(button, textButton.nextSibling);
      }
      return;
    }

    targetParent.insertBefore(button, textButton.nextSibling);
  }

  private getButtonLabel(element: HTMLElement): string {
    return [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("data-l10n-id"),
      element.textContent,
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  private isFreeTextToolLabel(label: string): boolean {
    return (
      /free text|add text|text annotation|^text$|\u65b0\u589e\u6587\u5b57|\u6dfb\u52a0\u6587\u5b57|\u6dfb\u52a0\u6587\u672c/i.test(
        label,
      ) && !/highlight|underline|\u9ad8\u4eae|\u4e0b\u5212\u7ebf/i.test(label)
    );
  }

  private findLastAnnotationToolButton(
    nativeButtons: HTMLElement[],
  ): HTMLElement | undefined {
    return nativeButtons
      .filter((candidate) => {
        const label = this.getButtonLabel(candidate);
        return (
          /highlight|underline|note|annotation|\u9ad8\u4eae|\u4e0b\u5212\u7ebf|\u6ce8\u91ca|\u7b14\u8bb0/i.test(
            label,
          ) &&
          !/page|zoom|sidebar|split|\u9875|\u7f29\u653e|\u4fa7\u8fb9\u680f|\u5206\u680f/i.test(
            label,
          )
        );
      })
      .at(-1);
  }

  private scheduleRender(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    repeat = false,
  ): void {
    const runtime = this.runtimes.get(reader);
    if (!runtime || runtime.disposed) {
      return;
    }

    if (runtime.renderTimer) {
      runtime.win.clearTimeout(runtime.renderTimer);
    }

    runtime.renderTimer = runtime.win.setTimeout(() => {
      runtime.renderTimer = undefined;
      this.renderIfNeeded(runtime);
    }, 50);

    if (repeat) {
      runtime.win.setTimeout(() => {
        if (!runtime.disposed) {
          this.renderIfNeeded(runtime);
        }
      }, 750);
    }
  }

  /**
   * Only run the full render pass when there is math to display or stale
   * overlays to clean up.
   *
   * The MutationObserver fires on every PDF.js DOM change, so on annotation-
   * free PDFs the render path would otherwise run its full document scan on
   * each change. Skip it when there is neither an active math annotation nor
   * any leftover overlay — rendering then has nothing to do. Once an overlay
   * exists (or an annotation is present) the original render path runs
   * unchanged, so cleanup of removed annotations is preserved.
   */
  private renderIfNeeded(runtime: ReaderRuntime): void {
    if (
      this.getMathAnnotations(runtime.reader).length === 0 &&
      !this.hasAnyManagerOverlay(runtime)
    ) {
      return;
    }
    this.renderMathAnnotations(runtime);
  }

  private hasAnyManagerOverlay(runtime: ReaderRuntime): boolean {
    for (const doc of this.getPDFPageDocuments(runtime)) {
      if (doc.querySelector(`.${MANAGER_RENDER_CLASS}`)) {
        return true;
      }
    }
    return false;
  }

  private getCurrentScale(runtime: ReaderRuntime): number | undefined {
    const app = (runtime.win as any)?.PDFViewerApplication;
    if (app?.pdfViewer?.currentScale !== undefined) {
      return app.pdfViewer.currentScale;
    }
    return app?.pdfViewer?.getPageView?.(0)?.viewport?.scale;
  }

  /**
   * Re-run the render once per animation frame while a zoom is in progress.
   * The full render is idempotent and cheap when nothing changed, and the
   * short-circuits in `renderIfNeeded` make the common no-math case a no-op.
   * This is triggered only by scale changes, so it never fires during text
   * selection or other non-zoom DOM churn.
   */
  private scheduleOverlaySync(runtime: ReaderRuntime): void {
    if (runtime.syncRAF !== undefined || runtime.disposed) {
      return;
    }
    runtime.syncRAF = runtime.win.requestAnimationFrame(() => {
      runtime.syncRAF = undefined;
      if (runtime.disposed) {
        return;
      }
      this.renderIfNeeded(runtime);
    });
  }

  private refreshObservedDocuments(runtime: ReaderRuntime): void {
    for (const doc of this.getRuntimeDocuments(runtime)) {
      if (runtime.observedDocs.has(doc) || !doc.body) {
        continue;
      }

      this.injectStyles(doc);
      const win = doc.defaultView ?? runtime.win;
      runtime.observedDocs.add(doc);
      this.installRenderedFormulaDblClickHandler(runtime, doc);

      try {
        const Observer = win.MutationObserver ?? runtime.win.MutationObserver;
        const observer = new Observer((mutations: MutationRecord[]) => {
          if (this.shouldIgnoreMutations(mutations)) {
            return;
          }
          this.hideNewRawMathText(runtime, mutations);
          // A scale change means the page re-render was a zoom: the overlay
          // pixel rects are stale until re-positioned. Tracking the scale lets
          // us re-sync promptly during the zoom instead of only after it
          // settles (the debounced render), avoiding visible formula drift/flash.
          const scale = this.getCurrentScale(runtime);
          if (scale !== undefined && scale !== runtime.lastScale) {
            runtime.lastScale = scale;
            this.scheduleOverlaySync(runtime);
          }
          this.scheduleRender(runtime.reader);
        });
        observer.observe(
          doc.body,
          this.createMutationObserverOptions(win) as MutationObserverInit,
        );
        runtime.observers.push(observer);
      } catch (error) {
        this.logError("Unable to observe reader document", error);
      }
    }
  }

  /**
   * Hide freshly-inserted raw math text before the next paint, without waiting
   * for the debounced render pass.
   *
   * pdf.js rebuilds the annotation layer (re-creating the `textarea` controls
   * that hold the raw `[[math:…]]` text) on zoom and re-render. Those new
   * controls lack the hidden class, and the 50ms debounce keeps getting reset
   * during a continuous zoom, so the raw text would otherwise stay visible for
   * the whole gesture. The MutationObserver fires before paint, so hiding the
   * added controls here removes the flash. Only the mutation's added nodes are
   * inspected — no full-document scan.
   */
  private hideNewRawMathText(
    runtime: ReaderRuntime,
    mutations: MutationRecord[],
  ): void {
    if (!this.readerHasMath(runtime.reader)) {
      return;
    }
    for (const mutation of mutations) {
      if (mutation.type !== "childList") {
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (node && node.nodeType === 1) {
          this.hideMathTextFields(node as Element);
        }
      }
    }
  }

  private hideMathTextFields(root: Element): void {
    const tag = root.localName.toLowerCase();
    if (tag === "textarea" || tag === "input") {
      this.hideMathTextField(root as HTMLElement);
      return;
    }
    for (const field of root.querySelectorAll<HTMLElement>("textarea,input")) {
      this.hideMathTextField(field);
    }
  }

  private hideMathTextField(field: HTMLElement): void {
    if (
      field.classList.contains(RAW_HIDDEN_CLASS) ||
      this.shouldSkipRawHide(field)
    ) {
      return;
    }
    const value = this.getTextFieldValue(field);
    if (value && this.parsePayload(value)) {
      field.classList.add(RAW_HIDDEN_CLASS);
      field.setAttribute("aria-hidden", "true");
    }
  }

  /**
   * Cheap "does this reader hold any math annotation" check for the observer
   * hot path. `_annotations.length` is the invalidation key, so adds/deletes
   * recompute while the steady state costs a single property read plus map
   * lookups — never a full scan on every mutation batch.
   */
  private readerHasMath(reader: _ZoteroTypes.ReaderInstance<"pdf">): boolean {
    const manager = this.getAnnotationManager(reader);
    const count = manager?._annotations?.length ?? 0;
    if (this.mathAnnotationCacheCounts.get(reader) === count) {
      const cached = this.mathAnnotationCache.get(reader);
      if (cached !== undefined) {
        return cached;
      }
    }
    const has = this.getMathAnnotations(reader).length > 0;
    this.mathAnnotationCacheCounts.set(reader, count);
    this.mathAnnotationCache.set(reader, has);
    return has;
  }

  private createMutationObserverOptions(win: Window): MutationObserverInit {
    const options: MutationObserverInit = {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "style",
        "class",
        "data-annotation-id",
        "data-annotation-key",
        "data-id",
        "data-editor-id",
        "data-page-number",
      ],
    };

    try {
      return Components.utils.cloneInto(options, win) as MutationObserverInit;
    } catch {
      return options;
    }
  }

  private shouldIgnoreMutations(mutations: MutationRecord[]): boolean {
    return mutations.every((mutation) => {
      if (!mutation.target) {
        return true;
      }

      const target =
        mutation.target.nodeType === 1
          ? (mutation.target as Element)
          : mutation.target.parentElement;
      if (!target) {
        return true;
      }

      return Boolean(
        target.closest(`.${PAGE_OVERLAY_CLASS}`) ||
        target.closest(`.${MANAGER_RENDER_CLASS}`) ||
        target.closest(".zotero-latex-math-modal") ||
        target.closest(".zotero-latex-math-editor-frame"),
      );
    });
  }

  private getRuntimeDocuments(runtime: ReaderRuntime): Document[] {
    const docs = [
      runtime.doc,
      ...this.collectReaderDocuments(runtime.reader),
    ].filter((doc): doc is Document => Boolean(doc?.body));

    return [...new Set(docs)].filter((doc) => {
      try {
        return !Components.utils.isDeadWrapper(doc.defaultView ?? doc);
      } catch {
        return false;
      }
    });
  }

  private renderMathAnnotations(runtime: ReaderRuntime): void {
    this.refreshObservedDocuments(runtime);
    const docs = this.getPDFPageDocuments(runtime);
    const overlayCount = this.renderManagerOverlays(runtime, docs);
    if (overlayCount > 0) {
      for (const doc of docs) {
        this.hideRawMathElements(doc);
      }
    }
    this.logRenderDiagnostics(runtime, {
      docCount: docs.length,
      overlayCount,
    });
  }

  private getPDFPageDocuments(runtime: ReaderRuntime): Document[] {
    return this.getRuntimeDocuments(runtime).filter((doc) =>
      Boolean(doc.querySelector(".page")),
    );
  }

  private installRenderedFormulaDblClickHandler(
    runtime: ReaderRuntime,
    doc: Document,
  ): void {
    const clickHandler = (event: Event) => {
      const mouseEvent = event as MouseEvent;
      const target = mouseEvent.target as Element | null;
      if (
        !target ||
        target.closest(".zotero-latex-math-modal") ||
        target.closest(".zotero-latex-math-editor-frame")
      ) {
        return;
      }

      const match = this.findMathAnnotationAtPoint(runtime, doc, mouseEvent);
      if (!match) {
        return;
      }

      this.selectAnnotation(runtime.reader, match.annotation.id);
    };

    const handler = (event: Event) => {
      const mouseEvent = event as MouseEvent;
      const target = mouseEvent.target as Element | null;
      if (
        !target ||
        target.closest(".zotero-latex-math-modal") ||
        target.closest(".zotero-latex-math-editor-frame")
      ) {
        return;
      }

      const match = this.findMathAnnotationAtPoint(runtime, doc, mouseEvent);
      if (!match) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      (
        event as Event & { stopImmediatePropagation?: () => void }
      ).stopImmediatePropagation?.();
      void this.openEditorInDocument(this.getEditorDocument(runtime), {
        initial: { latex: match.payload.latex, mode: match.payload.mode },
        title: getString("math-editor-edit-title"),
        onSave: async (payload) => {
          await this.updateManagerAnnotationByID(
            runtime.reader,
            match.annotation.id,
            payload,
            doc,
          );
          this.scheduleRender(runtime.reader, true);
        },
      });
    };

    doc.addEventListener("click", clickHandler, true);
    doc.addEventListener("dblclick", handler, true);
    runtime.documentCleanups.push(() => {
      doc.removeEventListener("click", clickHandler, true);
      doc.removeEventListener("dblclick", handler, true);
    });
  }

  private selectAnnotation(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    annotationID: string,
  ): void {
    const internalReader = reader._internalReader as any;
    const ids = this.cloneValueIntoRealm([annotationID], internalReader);

    if (internalReader?._state) {
      internalReader._state.selectedAnnotationIDs = ids;
    }

    for (const view of [
      internalReader?._primaryView,
      internalReader?._secondaryView,
      internalReader?._lastView,
    ] as any[]) {
      if (typeof view?.setSelectedAnnotationIDs === "function") {
        try {
          view.setSelectedAnnotationIDs(this.cloneValueIntoRealm(ids, view));
        } catch (error) {
          this.logError(
            "Unable to select math annotation in reader view",
            error,
          );
        }
      }
    }
  }

  private getEditorDocument(runtime: ReaderRuntime): Document {
    return (
      this.readerDocs.get(runtime.reader) ??
      runtime.reader._window?.document ??
      runtime.doc
    );
  }

  private findMathAnnotationAtPoint(
    runtime: ReaderRuntime,
    doc: Document,
    event: MouseEvent,
  ):
    | {
        annotation: _ZoteroTypes.Reader.Annotation;
        payload: MathPayload;
      }
    | undefined {
    const target = event.target as Element | null;
    const page =
      (target?.closest(".page") as HTMLElement | null) ??
      (doc
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest(".page") as HTMLElement | null);
    if (!page) {
      return undefined;
    }

    const pageIndex = this.getPageIndex(doc, page);
    const viewport =
      this.getPDFViewportFromWindow(doc.defaultView, pageIndex) ??
      this.getPDFViewport(runtime, pageIndex);
    const point = this.getViewportPoint(
      page,
      event.clientX,
      event.clientY,
      viewport,
    );
    const x = point.x;
    const y = point.y;
    const tolerance = 8;

    for (const annotation of this.getMathAnnotations(runtime.reader)) {
      const position = this.getPDFPosition(annotation);
      const payload = this.parsePayload(
        annotation.text ?? annotation.comment ?? "",
      );
      const rect = position?.rects?.[0];
      if (!position || !payload || !rect || position.pageIndex !== pageIndex) {
        continue;
      }

      const viewportRect = this.getViewportRect(runtime, doc, pageIndex, rect);
      if (!viewportRect) {
        continue;
      }

      if (
        x >= viewportRect.left - tolerance &&
        x <= viewportRect.left + viewportRect.width + tolerance &&
        y >= viewportRect.top - tolerance &&
        y <= viewportRect.top + viewportRect.height + tolerance
      ) {
        return { annotation, payload };
      }
    }

    return undefined;
  }

  private getElementsWithMathText(doc: Document): HTMLElement[] {
    // The raw math source always lives in a free-text annotation control
    // (Zotero renders text annotations as
    //   <textarea class="textAnnotation" data-id="<annotationID>">…</textarea>
    // with the `[[math:…]]` text in the control's value; confirmed on-device).
    // Scan only those controls — a full-document TreeWalker over every text
    // node in the viewer was a hot-path cost on each render pass.
    const elements = new Set<HTMLElement>();
    for (const field of [
      ...doc.querySelectorAll<HTMLElement>("textarea,input"),
    ]) {
      const value = this.getTextFieldValue(field);
      if (value && this.parsePayload(value)) {
        elements.add(field);
      }
    }
    return [...elements];
  }

  private hideRawMathElements(doc: Document): void {
    const activeElements = new Set(this.getElementsWithMathText(doc));

    for (const element of [
      ...doc.querySelectorAll<HTMLElement>(`.${RAW_HIDDEN_CLASS}`),
    ]) {
      if (
        !activeElements.has(element) ||
        !this.extractPayloadFromElement(element)
      ) {
        element.classList.remove(RAW_HIDDEN_CLASS);
        element.removeAttribute("aria-hidden");
      }
    }

    for (const element of activeElements) {
      if (this.shouldSkipRawHide(element)) {
        continue;
      }
      element.classList.add(RAW_HIDDEN_CLASS);
      element.setAttribute("aria-hidden", "true");
    }
  }

  private shouldSkipRawHide(element: HTMLElement): boolean {
    if (
      element.closest(`.${MANAGER_RENDER_CLASS}`) ||
      element.closest(`.${PAGE_OVERLAY_CLASS}`) ||
      element.closest(".zotero-latex-math-modal") ||
      element.closest(".zotero-latex-math-editor-frame")
    ) {
      return true;
    }

    return Boolean(
      element.matches(
        "html,body,#viewer,#viewerContainer,.page,.annotationLayer,.annotationEditorLayer",
      ),
    );
  }

  private renderManagerOverlays(
    runtime: ReaderRuntime,
    docs: Document[],
  ): number {
    const annotations = this.getMathAnnotations(runtime.reader);
    let rendered = 0;

    for (const doc of docs) {
      this.injectStyles(doc);
      const activeIDs = new Set(annotations.map((annotation) => annotation.id));

      // Only render overlays on documents that actually host the annotation
      // source controls. Zotero instantiates hidden duplicate PDF views
      // (primary/secondary), so a document can contain `.page` elements with
      // no math text at all — rendering an overlay there is pure waste.
      // Documents without a math source are cleaned, not rendered.
      if (this.getElementsWithMathText(doc).length === 0) {
        for (const element of [
          ...doc.querySelectorAll<HTMLElement>(`.${MANAGER_RENDER_CLASS}`),
        ]) {
          element.remove();
        }
        continue;
      }

      for (const annotation of annotations) {
        const position = this.getPDFPosition(annotation);
        const payload = this.parsePayload(
          annotation.text ?? annotation.comment ?? "",
        );
        const rect = position?.rects?.[0];
        if (!payload || !position || !rect) {
          continue;
        }

        const page = this.findPageElement(doc, position.pageIndex);
        if (!page) {
          continue;
        }

        const viewportRect = this.getViewportRect(
          runtime,
          doc,
          position.pageIndex,
          rect,
        );
        if (!viewportRect) {
          continue;
        }

        const overlay = this.getPageOverlay(doc, page);
        const element = this.getManagerOverlayElement(doc, overlay, annotation);
        this.renderManagerOverlayElement(
          runtime,
          element,
          annotation,
          payload,
          viewportRect,
        );
        rendered += 1;
      }

      for (const element of [
        ...doc.querySelectorAll<HTMLElement>(`.${MANAGER_RENDER_CLASS}`),
      ]) {
        const annotationID = element.dataset.annotationId;
        if (annotationID && !activeIDs.has(annotationID)) {
          element.remove();
        }
      }
    }

    return rendered;
  }

  private getMathAnnotations(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
  ): _ZoteroTypes.Reader.Annotation[] {
    const manager = this.getAnnotationManager(reader);
    return (manager?._annotations ?? []).filter(
      (annotation) =>
        annotation.type === "text" &&
        Boolean(this.parsePayload(annotation.text ?? annotation.comment ?? "")),
    );
  }

  /**
   * Backfill the derived `pageLabel` field for math annotations that lack it.
   *
   * Runs at explicit lifecycle points (reader init, annotation set/update) —
   * never on the render path — so rendering does not write to the annotation
   * store or cascade extra renders. In-memory only; Zotero re-derives the label
   * when annotations are reloaded.
   */
  private ensureAnnotationMetadata(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
  ): void {
    const manager = this.getAnnotationManager(reader);
    if (!manager) {
      return;
    }
    for (const annotation of this.getMathAnnotations(reader)) {
      if (annotation.pageLabel) {
        continue;
      }
      const position = this.getPDFPosition(annotation);
      if (!position) {
        continue;
      }
      annotation.pageLabel = this.getPageLabel(reader, position.pageIndex);
    }
  }

  private getPDFPosition(annotation: _ZoteroTypes.Reader.Annotation):
    | {
        pageIndex: number;
        rects?: number[][];
        paths?: number[][];
      }
    | undefined {
    const position = annotation.position as {
      pageIndex?: unknown;
      rects?: number[][];
      paths?: number[][];
    };
    if (typeof position.pageIndex !== "number") {
      return undefined;
    }
    return {
      pageIndex: position.pageIndex,
      rects: position.rects,
      paths: position.paths,
    };
  }

  private findPageElement(
    doc: Document,
    pageIndex: number,
  ): HTMLElement | undefined {
    return (
      doc.querySelector<HTMLElement>(
        `.page[data-page-number="${pageIndex + 1}"]`,
      ) ??
      [...doc.querySelectorAll<HTMLElement>(".page")][pageIndex] ??
      undefined
    );
  }

  private getPageOverlay(doc: Document, page: HTMLElement): HTMLElement {
    let overlay = page.querySelector<HTMLElement>(
      `:scope > .${PAGE_OVERLAY_CLASS}`,
    );
    if (overlay) {
      return overlay;
    }

    overlay = doc.createElement("div");
    overlay.className = PAGE_OVERLAY_CLASS;
    page.appendChild(overlay);

    const computedStyle = doc.defaultView?.getComputedStyle(page);
    if (computedStyle?.position === "static") {
      page.style.position = "relative";
    }

    return overlay;
  }

  private getManagerOverlayElement(
    doc: Document,
    overlay: HTMLElement,
    annotation: _ZoteroTypes.Reader.Annotation,
  ): HTMLElement {
    const escapedID = this.escapeCSSAttributeValue(annotation.id);
    let element = overlay.querySelector<HTMLElement>(
      `:scope > .${MANAGER_RENDER_CLASS}[data-annotation-id="${escapedID}"]`,
    );
    if (element) {
      return element;
    }

    element = doc.createElement("div");
    element.className = MANAGER_RENDER_CLASS;
    element.dataset.annotationId = annotation.id;
    overlay.appendChild(element);
    return element;
  }

  private renderManagerOverlayElement(
    _runtime: ReaderRuntime,
    element: HTMLElement,
    annotation: _ZoteroTypes.Reader.Annotation,
    payload: MathPayload,
    rect: ViewportRect,
  ): void {
    const currentSource = element.dataset.mathSource;
    const currentMode = element.dataset.mathMode;

    this.setStyleIfChanged(element, "left", `${rect.left}px`);
    this.setStyleIfChanged(element, "top", `${rect.top}px`);
    this.setStyleIfChanged(element, "width", `${Math.max(rect.width, 24)}px`);
    this.setStyleIfChanged(element, "height", `${Math.max(rect.height, 18)}px`);
    this.setStyleIfChanged(element, "color", annotation.color || "#111111");
    this.toggleClassIfChanged(
      element,
      "is-display",
      payload.mode === "display",
    );
    this.toggleClassIfChanged(element, "is-inline", payload.mode === "inline");
    this.setDatasetIfChanged(element, "mathMode", payload.mode);
    this.setDatasetIfChanged(element, "mathSource", payload.latex);

    if (
      currentSource !== payload.latex ||
      currentMode !== payload.mode ||
      !element.querySelector(`:scope > .${FIT_CONTENT_CLASS}`)
    ) {
      element.innerHTML = `<span class="${FIT_CONTENT_CLASS}">${this.renderLatex(
        payload.latex,
        payload.mode,
      )}</span>`;
    }
    this.fitFormulaToOverlay(element, rect);
    // Editing is handled by the document-level double-click handler
    // (installRenderedFormulaDblClickHandler); this element has
    // pointer-events: none, so no element-level listener would ever fire.
  }

  private fitFormulaToOverlay(element: HTMLElement, rect: ViewportRect): void {
    const content = element.querySelector<HTMLElement>(
      `:scope > .${FIT_CONTENT_CLASS}`,
    );
    if (!content) {
      return;
    }

    content.style.position = "absolute";
    content.style.transform = "";
    content.style.left = "0";
    content.style.top = "0";

    const contentRect = content.getBoundingClientRect();
    if (!contentRect.width || !contentRect.height) {
      return;
    }

    const scale = this.clamp(
      Math.min(
        Math.max(rect.width, 1) / contentRect.width,
        Math.max(rect.height, 1) / contentRect.height,
      ),
      0.1,
      12,
    );
    const left = Math.max(0, (rect.width - contentRect.width * scale) / 2);
    const top = Math.max(0, (rect.height - contentRect.height * scale) / 2);

    content.style.transformOrigin = "left top";
    content.style.transform = `scale(${scale})`;
    content.style.left = `${left}px`;
    content.style.top = `${top}px`;
  }

  private setStyleIfChanged(
    element: HTMLElement,
    property: string,
    value: string,
  ): void {
    if (element.style.getPropertyValue(property) !== value) {
      element.style.setProperty(property, value);
    }
  }

  private toggleClassIfChanged(
    element: HTMLElement,
    className: string,
    enabled: boolean,
  ): void {
    if (element.classList.contains(className) !== enabled) {
      element.classList.toggle(className, enabled);
    }
  }

  private setDatasetIfChanged(
    element: HTMLElement,
    key: string,
    value: string,
  ): void {
    if (element.dataset[key] !== value) {
      element.dataset[key] = value;
    }
  }

  private getViewportRect(
    runtime: ReaderRuntime,
    doc: Document,
    pageIndex: number,
    rect: number[],
  ): ViewportRect | undefined {
    const win = doc.defaultView ?? runtime.win;
    const viewport =
      this.getPDFViewportFromWindow(win, pageIndex) ??
      this.getPDFViewport(runtime, pageIndex);
    const viewportRect =
      viewport?.convertToViewportRectangle && win
        ? this.toPlainNumberArray(
            viewport.convertToViewportRectangle(
              this.cloneNumberArrayIntoWindow(rect, win),
            ),
          )
        : rect;
    if (viewportRect.length < 4) {
      return undefined;
    }

    const left = Math.min(viewportRect[0], viewportRect[2]);
    const top = Math.min(viewportRect[1], viewportRect[3]);
    const right = Math.max(viewportRect[0], viewportRect[2]);
    const bottom = Math.max(viewportRect[1], viewportRect[3]);
    return {
      left,
      top,
      width: right - left,
      height: bottom - top,
    };
  }

  private logRenderDiagnostics(
    runtime: ReaderRuntime,
    stats: {
      docCount: number;
      overlayCount: number;
    },
  ): void {
    // Diagnostics walk every text node in the viewer; never run them in
    // production, where they would be pure overhead on every render pass.
    if (__env__ !== "development") {
      return;
    }

    const mathAnnotations = this.getMathAnnotations(runtime.reader);
    if (!mathAnnotations.length) {
      return;
    }

    const docs = this.getRuntimeDocuments(runtime);
    const summary = {
      ...stats,
      mathAnnotationCount: mathAnnotations.length,
      annotations: mathAnnotations.slice(0, 5).map((annotation) => ({
        id: annotation.id,
        pageIndex: this.getPDFPosition(annotation)?.pageIndex,
        rect: this.getPDFPosition(annotation)?.rects?.[0],
        textPrefix: (annotation.text ?? annotation.comment ?? "").slice(0, 32),
      })),
      docs: docs.map((doc, index) => ({
        index,
        url: doc.location?.href,
        pages: doc.querySelectorAll(".page").length,
        annotationLayers: doc.querySelectorAll(".annotationLayer").length,
        editorLayers: doc.querySelectorAll(".annotationEditorLayer").length,
        mathTextNodes: this.getElementsWithMathText(doc).length,
        managerOverlays: doc.querySelectorAll(`.${MANAGER_RENDER_CLASS}`)
          .length,
        sampleMathElements: this.getElementsWithMathText(doc)
          .slice(0, 3)
          .map((element) => this.describeElement(element)),
      })),
    };
    const signature = JSON.stringify(summary);
    if (this.lastRenderDiagnostics.get(runtime.reader) === signature) {
      return;
    }

    this.lastRenderDiagnostics.set(runtime.reader, signature);
    Zotero.debug(`[LaTeX Math Tool] render diagnostics ${signature}`);
  }

  private describeElement(element: HTMLElement): Record<string, string> {
    return {
      tag: element.localName,
      id: element.id,
      class: element.className,
      dataAnnotationId: element.dataset.annotationId ?? "",
      dataAnnotationKey: element.dataset.annotationKey ?? "",
      dataID: element.dataset.id ?? "",
      dataEditorID: element.dataset.editorId ?? "",
      text: this.getSourceText(element).slice(0, 80),
    };
  }

  private async openEditorInDocument(
    doc: Document,
    options: {
      title: string;
      initial: { latex: string; mode: MathMode };
      onSave: (payload: MathPayload) => Promise<void> | void;
    },
  ): Promise<void> {
    const editorHost = this.createEditorHost(doc);
    const editorDoc = editorHost.doc;
    this.injectStyles(editorDoc);

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
    input.value = options.initial.latex;
    input.placeholder = "\\frac{a}{b} = c";
    input.rows = 5;

    const preview = create("div");
    preview.className = "zotero-latex-math-preview";

    const modeLabel = create("label");
    modeLabel.className = "zotero-latex-math-mode";

    const displayMode = create("input");
    displayMode.type = "checkbox";
    displayMode.checked = options.initial.mode === "display";

    const modeText = create("span");
    modeText.textContent = getString("math-editor-display-mode");
    modeLabel.append(displayMode, modeText);

    const actions = create("div");
    actions.className = "zotero-latex-math-actions";

    const cancel = create("button");
    cancel.type = "button";
    cancel.textContent = getString("math-editor-cancel");

    const save = create("button");
    save.type = "button";
    save.className = "primary";
    save.textContent = options.initial.latex
      ? getString("math-editor-save")
      : getString("math-editor-insert");

    actions.append(cancel, save);
    panel.append(title, input, preview, modeLabel, actions);
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

    const close = () => editorHost.destroy();
    const updatePreview = () => {
      const latex = input.value.trim();
      const mode: MathMode = displayMode.checked ? "display" : "inline";
      save.disabled = latex.length === 0;
      preview.classList.toggle("is-empty", latex.length === 0);
      preview.innerHTML = latex
        ? this.renderLatex(latex, mode)
        : getString("math-editor-empty-preview");
    };

    const saveFormula = async () => {
      const latex = input.value.trim();
      if (!latex || save.disabled) {
        return;
      }

      const mode: MathMode = displayMode.checked ? "display" : "inline";
      save.disabled = true;
      try {
        await options.onSave(
          this.encodePayload(latex, mode, this.measureFormulaPreview(preview)),
        );
        close();
      } catch (error) {
        const message = this.stringifyError(error);
        preview.classList.remove("is-empty");
        preview.innerHTML = `<span class="zotero-latex-math-error">${this.escapeHTML(
          message,
        )}</span>`;
        save.disabled = false;
      }
    };

    input.addEventListener("input", updatePreview);
    displayMode.addEventListener("change", updatePreview);
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

    updatePreview();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  private createEditorHost(doc: Document): {
    doc: Document;
    destroy: () => void;
  } {
    const frame = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "iframe",
    ) as HTMLIFrameElement;
    frame.className = "zotero-latex-math-editor-frame";
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

  private async createAnnotationWithManager(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    manager: AnnotationManager,
    location: ClickLocation,
    payload: MathPayload,
    doc?: Document,
  ): Promise<void> {
    const fontSize = 14;
    const rect =
      doc && payload.renderedSize
        ? this.resizeLocationRect(doc, location, payload.renderedSize, reader)
        : location.rect;
    const rawAnnotation = {
      id: manager._generateObjectKey?.() ?? Zotero.Utilities.randomString(8),
      type: "text",
      color: "#000000",
      pageLabel: this.getPageLabel(reader, location.pageIndex, doc),
      sortIndex: this.createSortIndex(location),
      position: {
        pageIndex: location.pageIndex,
        fontSize,
        rotation: 0,
        rects: [rect],
      },
      text: payload.encoded,
      comment: payload.encoded,
      tags: [],
      dateCreated: new Date().toISOString(),
      dateModified: new Date().toISOString(),
      authorName: manager._authorName,
    } as _ZoteroTypes.Reader.Annotation;
    const annotation = this.cloneIntoManagerRealm(manager, rawAnnotation);

    manager.updateAnnotations?.(
      this.replaceManagedAnnotation(manager, annotation),
    );
    manager._save?.(annotation, true);
  }

  private async updateManagerAnnotation(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    annotation: _ZoteroTypes.Reader.Annotation,
    payload: MathPayload,
    doc?: Document,
  ): Promise<void> {
    const manager = this.getAnnotationManager(reader);
    if (!manager) {
      throw new Error("Reader annotation manager is not available");
    }

    annotation.text = payload.encoded;
    annotation.comment = payload.encoded;
    if (doc && payload.renderedSize) {
      this.resizeAnnotationRect(
        reader,
        manager,
        annotation,
        doc,
        payload.renderedSize,
      );
    }
    annotation.dateModified = new Date().toISOString();
    manager.updateAnnotations?.(
      this.replaceManagedAnnotation(manager, annotation),
    );
    manager._save?.(annotation, true);
  }

  private async updateManagerAnnotationByID(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    annotationID: string,
    payload: MathPayload,
    doc?: Document,
  ): Promise<void> {
    const manager = this.getAnnotationManager(reader);
    const annotation =
      manager?._getAnnotationByID?.(annotationID) ??
      manager?._annotations?.find((candidate) => candidate.id === annotationID);
    if (!annotation) {
      throw new Error("Unable to resolve the underlying Zotero annotation");
    }

    await this.updateManagerAnnotation(reader, annotation, payload, doc);
  }

  private replaceManagedAnnotation(
    manager: AnnotationManager,
    annotation: _ZoteroTypes.Reader.Annotation,
  ): _ZoteroTypes.Reader.Annotation[] {
    const index = manager._annotations.findIndex(
      (candidate) => candidate.id === annotation.id,
    );
    if (index === -1) {
      manager._annotations.push(annotation);
    } else {
      manager._annotations[index] = annotation;
    }

    return manager._annotations.filter(
      (candidate) => candidate.id === annotation.id,
    );
  }

  private cloneIntoManagerRealm<T>(manager: AnnotationManager, value: T): T {
    return this.cloneValueIntoRealm(value, manager._annotations);
  }

  private cloneValueIntoRealm<T>(value: T, target: object | undefined): T {
    if (!target) {
      return value;
    }

    try {
      return Components.utils.cloneInto(value, target, {
        cloneFunctions: false,
      }) as T;
    } catch (error) {
      this.logError("Unable to clone value into target realm", error);
      return value;
    }
  }

  private getClickLocationFromDocument(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    doc: Document,
    event: MouseEvent,
  ): ClickLocation | undefined {
    const target = event.target as Element | null;
    // The click must land on an actual `.page` element. The toolbar lives in
    // the same document as the pages, so without this requirement a toolbar
    // click (e.g. on the Σ button while math insert mode is armed) would fall
    // through to the first `.page` and wrongly open the editor.
    const page =
      (target?.closest(".page") as HTMLElement | null | undefined) ??
      (doc.elementFromPoint(event.clientX, event.clientY)?.closest(".page") as
        | HTMLElement
        | null
        | undefined);
    if (!page) {
      return undefined;
    }

    const pageIndex = this.getPageIndex(doc, page);
    const width = 220;
    const height = 48;
    const viewport =
      this.getPDFViewportFromWindow(doc.defaultView, pageIndex) ??
      this.getPDFViewportFromReader(reader, pageIndex);
    const point = this.getViewportPoint(
      page,
      event.clientX,
      event.clientY,
      viewport,
    );
    const x = Math.max(0, point.x);
    const y = Math.max(0, point.y);

    if (viewport?.convertToPdfPoint) {
      const start = this.toPlainNumberArray(viewport.convertToPdfPoint(x, y));
      const end = this.toPlainNumberArray(
        viewport.convertToPdfPoint(x + width, y + height),
      );
      return {
        pageIndex,
        rect: this.normalizeRect([start[0], start[1], end[0], end[1]]),
      };
    }

    return { pageIndex, rect: [x, y, x + width, y + height] };
  }

  private getPageIndex(doc: Document, page: HTMLElement): number {
    const pageNumber = Number(page.dataset.pageNumber);
    if (Number.isFinite(pageNumber) && pageNumber > 0) {
      return pageNumber - 1;
    }
    return [...doc.querySelectorAll<HTMLElement>(".page")].indexOf(page);
  }

  private getPDFViewport(
    runtime: ReaderRuntime,
    pageIndex: number,
  ): Viewport | undefined {
    return this.getPDFViewportFromWindow(runtime.win, pageIndex);
  }

  private getPDFViewportFromReader(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    pageIndex: number,
  ): Viewport | undefined {
    const internalReader = reader._internalReader as any;
    for (const view of [
      internalReader?._primaryView,
      internalReader?._secondaryView,
      internalReader?._lastView,
    ]) {
      const viewport = this.getPDFViewportFromWindow(
        view?._iframeWindow ?? view?._iframe?.contentWindow,
        pageIndex,
      );
      if (viewport) {
        return viewport;
      }
    }
    return undefined;
  }

  private getPageLabel(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    pageIndex: number,
    doc?: Document,
  ): string {
    const internalReader = reader._internalReader as any;
    const windows = [
      doc?.defaultView,
      internalReader?._primaryView?._iframeWindow,
      internalReader?._secondaryView?._iframeWindow,
      internalReader?._lastView?._iframeWindow,
    ];
    for (const win of windows) {
      const label = (win as any)?.PDFViewerApplication?.pdfViewer
        ?._pageLabels?.[pageIndex];
      if (label !== undefined && label !== null && String(label).length) {
        return String(label);
      }
    }
    return String(pageIndex + 1);
  }

  private getPDFViewportFromWindow(
    win: Window | null,
    pageIndex: number,
  ): Viewport | undefined {
    const app = (win as any)?.PDFViewerApplication;
    return app?.pdfViewer?.getPageView?.(pageIndex)?.viewport;
  }

  private getViewportPoint(
    page: HTMLElement,
    clientX: number,
    clientY: number,
    viewport?: Viewport,
  ): { x: number; y: number } {
    // PDF.js pages can include a transparent border outside viewport (0, 0).
    const surface =
      page.querySelector<HTMLElement>(":scope > .canvasWrapper") ??
      page.querySelector<HTMLElement>(".canvasWrapper") ??
      page.querySelector<HTMLElement>("canvas");
    const surfaceRect = surface?.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    const left = surfaceRect?.width
      ? surfaceRect.left
      : pageRect.left + page.clientLeft;
    const top = surfaceRect?.height
      ? surfaceRect.top
      : pageRect.top + page.clientTop;
    const renderedWidth = surfaceRect?.width || page.clientWidth;
    const renderedHeight = surfaceRect?.height || page.clientHeight;
    const scaleX =
      viewport?.width && renderedWidth ? viewport.width / renderedWidth : 1;
    const scaleY =
      viewport?.height && renderedHeight ? viewport.height / renderedHeight : 1;

    return {
      x: (clientX - left) * scaleX,
      y: (clientY - top) * scaleY,
    };
  }

  private getSourceText(element: HTMLElement): string {
    const ownValue = this.getTextFieldValue(element);
    if (ownValue) {
      return ownValue.trim();
    }

    const field = [...element.querySelectorAll<HTMLElement>("textarea,input")]
      .map((candidate) => this.getTextFieldValue(candidate))
      .find((value) => value?.trim());
    if (field) {
      return field.trim();
    }

    return (element.textContent ?? "").trim();
  }

  private getTextFieldValue(element: Element): string | undefined {
    const tagName = element.localName.toLowerCase();
    if (tagName !== "textarea" && tagName !== "input") {
      return undefined;
    }

    return (element as HTMLInputElement | HTMLTextAreaElement).value;
  }

  private extractPayloadFromElement(element: HTMLElement): MathPayload | null {
    const sourceText =
      element.getAttribute("data-math-encoded") || this.getSourceText(element);
    return this.parsePayload(sourceText);
  }

  private parsePayload(text: string): MathPayload | null {
    const trimmed = text.trim();
    const displayIndex = trimmed.indexOf(DISPLAY_PREFIX);
    const inlineIndex = trimmed.indexOf(INLINE_PREFIX);
    if (displayIndex >= 0) {
      return this.encodePayload(
        trimmed.slice(displayIndex + DISPLAY_PREFIX.length).trim(),
        "display",
      );
    }
    if (inlineIndex >= 0) {
      return this.encodePayload(
        trimmed.slice(inlineIndex + INLINE_PREFIX.length).trim(),
        "inline",
      );
    }
    return null;
  }

  private encodePayload(
    latex: string,
    mode: MathMode,
    renderedSize?: FormulaSize,
  ): MathPayload {
    const prefix = mode === "display" ? DISPLAY_PREFIX : INLINE_PREFIX;
    return {
      mode,
      latex,
      encoded: `${prefix} ${latex}`,
      renderedSize,
    };
  }

  private measureFormulaPreview(preview: HTMLElement): FormulaSize | undefined {
    const html = String(preview.innerHTML);
    if (!html.trim()) {
      return undefined;
    }

    const doc = preview.ownerDocument;
    if (!doc?.body) {
      return undefined;
    }

    const measure = doc.createElement("div");
    measure.className = "zotero-latex-math-measure";
    measure.innerHTML = html;
    measure.style.position = "fixed";
    measure.style.left = "-10000px";
    measure.style.top = "-10000px";
    measure.style.display = "inline-block";
    measure.style.width = "max-content";
    measure.style.height = "max-content";
    measure.style.visibility = "hidden";
    doc.body.appendChild(measure);

    const rect = measure.getBoundingClientRect();
    measure.remove();
    if (!rect.width || !rect.height) {
      return undefined;
    }

    return {
      width: this.clamp(Math.ceil(rect.width + 16), 36, 720),
      height: this.clamp(Math.ceil(rect.height + 10), 24, 260),
    };
  }

  private resizeLocationRect(
    doc: Document,
    location: ClickLocation,
    size: FormulaSize,
    reader?: _ZoteroTypes.ReaderInstance<"pdf">,
  ): number[] {
    const viewport =
      this.getPDFViewportFromWindow(doc.defaultView, location.pageIndex) ??
      (reader
        ? this.getPDFViewportFromReader(reader, location.pageIndex)
        : undefined);
    const win = doc.defaultView;
    if (
      !win ||
      !viewport?.convertToViewportRectangle ||
      !viewport.convertToPdfPoint
    ) {
      return [
        location.rect[0],
        location.rect[1],
        location.rect[0] + size.width,
        location.rect[1] + size.height,
      ];
    }

    const viewportRect = this.toPlainNumberArray(
      viewport.convertToViewportRectangle(
        this.cloneNumberArrayIntoWindow(location.rect, win),
      ),
    );
    const left = Math.min(viewportRect[0], viewportRect[2]);
    const top = Math.min(viewportRect[1], viewportRect[3]);
    const start = this.toPlainNumberArray(
      viewport.convertToPdfPoint(left, top),
    );
    const end = this.toPlainNumberArray(
      viewport.convertToPdfPoint(left + size.width, top + size.height),
    );
    return this.normalizeRect([start[0], start[1], end[0], end[1]]);
  }

  private cloneNumberArrayIntoWindow(values: number[], win: Window): number[] {
    const plainValues = values.map((value) => Number(value));
    try {
      return Components.utils.cloneInto(plainValues, win) as number[];
    } catch {
      return plainValues;
    }
  }

  private toPlainNumberArray(values: ArrayLike<number>): number[] {
    return Array.from({ length: values.length }, (_value, index) =>
      Number(values[index]),
    );
  }

  private normalizeRect(rect: number[]): number[] {
    return [
      Math.min(rect[0], rect[2]),
      Math.min(rect[1], rect[3]),
      Math.max(rect[0], rect[2]),
      Math.max(rect[1], rect[3]),
    ];
  }

  private resizeAnnotationRect(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    manager: AnnotationManager,
    annotation: _ZoteroTypes.Reader.Annotation,
    doc: Document,
    size: FormulaSize,
  ): void {
    const position = this.getPDFPosition(annotation);
    const rect = position?.rects?.[0];
    if (!position || !rect) {
      return;
    }

    const resized = this.resizeLocationRect(
      doc,
      { pageIndex: position.pageIndex, rect },
      size,
      reader,
    );
    const annotationPosition = annotation.position as {
      rects?: number[][];
    };
    annotationPosition.rects = this.cloneIntoManagerRealm(manager, [
      resized.map((value) => Number(value)),
    ]);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private renderLatex(latex: string, mode: MathMode): string {
    try {
      return renderToString(latex, {
        displayMode: mode === "display",
        throwOnError: false,
        strict: "ignore",
        trust: false,
        output: "htmlAndMathml",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "KaTeX render failed";
      return `<span class="zotero-latex-math-error">${this.escapeHTML(
        message,
      )}</span>`;
    }
  }

  private injectStyles(doc: Document): void {
    if (doc.getElementById(STYLE_ID)) {
      return;
    }

    const katexCSS = this.inlineKatexFonts(katexStyles);
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `${katexCSS}\n${toolStyles}`;
    doc.documentElement?.appendChild(style);
  }

  private inlineKatexFonts(css: string): string {
    return css
      .replace(/url\(fonts\/([^)]+\.woff2)\)/g, (_match, fileName: string) => {
        const url = katexFontURLs[fileName];
        return url ? `url(${url})` : `url(fonts/${fileName})`;
      })
      .replace(
        /,url\(fonts\/[^)]*\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g,
        "",
      );
  }

  private injectToolbarStyles(doc: Document): void {
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
        box-shadow: inset 0 -2px 0 currentColor;
      }
    `;
    doc.documentElement?.appendChild(style);
  }

  private getAnnotationManager(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
  ): AnnotationManager | undefined {
    return reader._internalReader?._annotationManager as
      | AnnotationManager
      | undefined;
  }

  private async waitForPDFWindow(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    timeout = 15000,
  ): Promise<Window | undefined> {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const win = this.getPDFWindow(reader);
      if (win?.document?.body) {
        return win;
      }
      await Zotero.Promise.delay(100);
    }
    return this.getPDFWindow(reader);
  }

  private getPDFWindow(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
  ): Window | undefined {
    const readerAny = reader as any;
    const primaryView = readerAny._internalReader?._primaryView;
    const candidates = [
      primaryView?._iframeWindow,
      primaryView?._iframe?.contentWindow,
      readerAny._iframeWindow,
      readerAny._iframe?.contentWindow,
      this.readerDocs.get(reader)?.defaultView,
      ...this.getNestedFrameWindows(primaryView?._iframeWindow?.document),
      ...this.getNestedFrameWindows(readerAny._iframeWindow?.document),
      ...this.getNestedFrameWindows(this.readerDocs.get(reader)),
    ].filter((win): win is Window => Boolean(win?.document?.body));

    return candidates.find((win) => this.isPDFCanvasWindow(win));
  }

  private getNestedFrameWindows(
    doc?: Document,
    seen = new Set<Document>(),
  ): Window[] {
    if (!doc) {
      return [];
    }

    if (seen.has(doc)) {
      return [];
    }
    seen.add(doc);

    const windows = [...doc.querySelectorAll("iframe,browser")]
      .map((frame) => {
        const frameAny = frame as any;
        return (frameAny.contentWindow ||
          frameAny.contentDocument?.defaultView) as Window | undefined;
      })
      .filter((win): win is Window => Boolean(win?.document?.body));

    const nested = windows.flatMap((win) =>
      this.getNestedFrameWindows(win.document, seen),
    );

    return [...windows, ...nested];
  }

  private isPDFCanvasWindow(win: Window): boolean {
    return Boolean(
      (win as any).PDFViewerApplication ||
      win.document.querySelector(".page") ||
      win.document.querySelector("#viewerContainer"),
    );
  }

  private setNativeTool(
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

  private createSortIndex(location: ClickLocation): string {
    const x = Math.round(location.rect[0]);
    const y = Math.round(location.rect[1]);
    return [
      location.pageIndex.toString().padStart(5, "0"),
      this.formatSortIndexCoordinate(y, 6),
      this.formatSortIndexCoordinate(x, 5),
    ].join("|");
  }

  private formatSortIndexCoordinate(value: number, width: number): string {
    const sign = value < 0 ? "-" : "";
    const absValue = Math.abs(value)
      .toString()
      .padStart(width - sign.length, "0");
    return `${sign}${absValue}`;
  }

  private disposeRuntime(runtime: ReaderRuntime): void {
    if (runtime.disposed) {
      return;
    }
    runtime.disposed = true;
    try {
      this.cancelMathInsertMode(runtime.reader);
    } catch (error) {
      this.logError("Unable to cancel math insert mode on dispose", error);
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
      if (runtime.syncRAF !== undefined) {
        runtime.win.cancelAnimationFrame(runtime.syncRAF);
        runtime.syncRAF = undefined;
      }
    } catch (error) {
      this.logError("Unable to clean up reader window listeners", error);
    }
    for (const doc of this.getRuntimeDocuments(runtime)) {
      doc.getElementById(STYLE_ID)?.remove();
    }
    this.runtimeSet.delete(runtime);
  }

  private escapeHTML(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  private escapeCSSAttributeValue(value: string): string {
    return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  }

  private stringifyError(error: unknown): string {
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

  private logError(message: string, error: unknown): void {
    Zotero.debug(`[LaTeX Math Tool] ${message}: ${this.stringifyError(error)}`);
  }

  private showError(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    message: string,
  ): void {
    const win = reader._iframeWindow ?? Zotero.getMainWindow();
    win?.alert?.(message);
  }
}
