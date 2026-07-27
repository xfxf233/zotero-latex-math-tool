import katexStyles from "katex/dist/katex.min.css";
import { renderToString } from "katex";
import { katexFontURLs } from "./katexFonts";
import toolStyles from "./styles.css";

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

type RenderCandidate = {
  element: HTMLElement;
  payload: MathPayload;
};

type Viewport = {
  convertToPdfPoint?: (x: number, y: number) => number[];
  convertToViewportRectangle?: (rect: number[]) => number[];
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
  buttons: Set<HTMLButtonElement>;
  activeClickHandler?: EventListener;
  resizeHandler: EventListener;
  renderTimer?: number;
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
const ACTIVE_CLASS = "zotero-latex-math-tool-insert-active";
const RENDER_CLASS = "zotero-latex-math-render";
const SOURCE_CLASS = "zotero-latex-math-source";
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
  private nativeTextButtons = new WeakMap<
    _ZoteroTypes.ReaderInstance,
    HTMLElement
  >();
  private watchedToolbarDocs = new WeakSet<Document>();
  private forwardingNativeTextClickReaders =
    new WeakSet<_ZoteroTypes.ReaderInstance>();
  private nativeTextInsertReaders = new WeakSet<_ZoteroTypes.ReaderInstance>();
  private knownAnnotationIDs = new WeakMap<
    _ZoteroTypes.ReaderInstance,
    Set<string>
  >();
  private directInsertCleanups = new WeakMap<
    _ZoteroTypes.ReaderInstance,
    Array<() => void>
  >();
  private patchedManagers = new WeakSet<AnnotationManager>();
  private runtimeSet = new Set<ReaderRuntime>();
  private lastRenderDiagnostics = new WeakMap<
    _ZoteroTypes.ReaderInstance,
    string
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
      buttons: new Set(this.getToolbarButtons(reader)),
      resizeHandler,
      disposed: false,
    };

    this.runtimes.set(reader, runtime);
    this.runtimeSet.add(runtime);
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

    const button = event.doc.createElement("button");
    button.type = "button";
    button.className = "toolbar-button zotero-latex-math-toolbar-button";
    button.title = "\u63d2\u5165 LaTeX \u6570\u5b66\u516c\u5f0f";
    button.setAttribute(
      "aria-label",
      "\u63d2\u5165 LaTeX \u6570\u5b66\u516c\u5f0f",
    );
    button.setAttribute("aria-pressed", "false");
    button.textContent = "\u03a3";
    button.style.minWidth = "32px";
    button.style.fontSize = "18px";
    button.style.fontWeight = "700";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        if (this.nativeTextInsertReaders.has(reader)) {
          this.cancelMathInsertMode(reader);
          return;
        }
        this.setToolbarButtonsActive(reader, true);
        await this.activateNativeTextInsertMode(reader);
      } catch (error) {
        this.setToolbarButtonsActive(reader, false);
        this.logError("Unable to activate LaTeX insert mode", error);
        this.showError(
          reader,
          "\u65e0\u6cd5\u5207\u6362\u5230 Zotero \u65b0\u589e\u6587\u5b57\u5de5\u5177\u3002\u8bf7\u91cd\u65b0\u6253\u5f00 PDF \u540e\u518d\u8bd5\u4e00\u6b21\u3002",
        );
      } finally {
        button.disabled = false;
      }
    });
    this.getToolbarButtons(reader).add(button);
    this.runtimes.get(reader)?.buttons.add(button);
    event.append(button);
    event.doc.defaultView?.requestAnimationFrame(() =>
      this.relocateToolbarButton(reader, button, event.doc),
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

    doc.addEventListener(
      "click",
      (event) => {
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

        if (
          this.forwardingNativeTextClickReaders.has(reader) &&
          button === this.nativeTextButtons.get(reader)
        ) {
          return;
        }

        this.cancelMathInsertMode(reader);
      },
      true,
    );
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

  private setRuntimeButtonsActive(
    runtime: ReaderRuntime,
    active: boolean,
  ): void {
    for (const button of runtime.buttons) {
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
    this.setToolbarButtonsActive(runtime.reader, active);
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

    this.ensureReader(reader).catch((error) =>
      this.logError(
        "Unable to initialize renderer after text tool activation",
        error,
      ),
    );
  }

  private cancelMathInsertMode(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
  ): void {
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
    this.setNativeTool(reader, { type: "pointer" });
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

      const mouseEvent = event as MouseEvent;
      const doc = (event.currentTarget as Document | null) ?? undefined;
      if (!doc) {
        return;
      }

      const location = this.getClickLocationFromDocument(doc, mouseEvent);
      if (!location) {
        return;
      }

      handled = true;
      event.preventDefault();
      event.stopPropagation();
      this.cancelMathInsertMode(reader);

      void this.openEditorInDocument(this.readerDocs.get(reader) ?? doc, {
        initial: { latex: "", mode: "display" },
        title: "\u63d2\u5165 LaTeX \u6570\u5b66\u516c\u5f0f",
        onSave: async (payload) => {
          await this.createAnnotationWithManager(
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
      this.captureNativeTextAnnotation(reader, manager, created);
      return created;
    }) as typeof manager.addAnnotation;

    const originalUpdateAnnotations = manager.updateAnnotations?.bind(manager);
    if (originalUpdateAnnotations) {
      manager.updateAnnotations = ((
        annotations: _ZoteroTypes.Reader.Annotation[],
      ) => {
        for (const annotation of annotations) {
          this.captureNativeTextAnnotation(reader, manager, annotation);
        }
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
          this.captureNativeTextAnnotation(reader, manager, annotation);
        }
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
        this.captureNativeTextAnnotation(reader, manager, annotation);
        const result = originalSave(annotation, instant);
        if (this.hasMathAnnotation([annotation])) {
          this.scheduleRender(reader, true);
        }
        return result;
      }) as typeof manager._save;
    }

    this.patchedManagers.add(manager);
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

  private async watchForNativeTextAnnotation(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    manager: AnnotationManager,
  ): Promise<void> {
    const started = Date.now();
    while (
      this.nativeTextInsertReaders.has(reader) &&
      Date.now() - started < 15000
    ) {
      const knownIDs = this.knownAnnotationIDs.get(reader) ?? new Set<string>();
      const annotation = manager._annotations?.find(
        (candidate) =>
          candidate.type === "text" &&
          candidate.id &&
          !knownIDs.has(candidate.id),
      );
      if (
        annotation &&
        this.captureNativeTextAnnotation(reader, manager, annotation)
      ) {
        return;
      }
      await Zotero.Promise.delay(200);
    }
  }

  private captureNativeTextAnnotation(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    manager: AnnotationManager,
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

    const knownIDs = this.knownAnnotationIDs.get(reader);
    if (annotation.id && knownIDs?.has(annotation.id)) {
      return false;
    }

    this.nativeTextInsertReaders.delete(reader);
    this.setToolbarButtonsActive(reader, false);
    this.setNativeTool(reader, { type: "pointer" });
    void this.completeNativeMathAnnotation(reader, manager, annotation);
    return true;
  }

  private async completeNativeMathAnnotation(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    manager: AnnotationManager,
    annotation: _ZoteroTypes.Reader.Annotation,
  ): Promise<void> {
    const doc = this.readerDocs.get(reader) ?? reader._iframeWindow?.document;
    if (!doc) {
      return;
    }

    await this.openEditorInDocument(doc, {
      initial: { latex: "", mode: "display" },
      title: "\u63d2\u5165 LaTeX \u6570\u5b66\u516c\u5f0f",
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
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
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

    if (textButton) {
      this.nativeTextButtons.set(reader, textButton);
    }

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

  private activateInsertMode(runtime: ReaderRuntime): void {
    this.ensurePointerTool(runtime.reader);
    this.deactivateInsertMode(runtime);
    runtime.doc.body?.classList.add(ACTIVE_CLASS);
    this.setRuntimeButtonsActive(runtime, true);

    const clickHandler: EventListener = (event) => {
      const pointerEvent = event as MouseEvent;
      const target = pointerEvent.target as Element | null;
      if (!target || target.closest(`.${RENDER_CLASS}`)) {
        return;
      }

      const location = this.getClickLocation(runtime, pointerEvent);
      if (!location) {
        return;
      }

      pointerEvent.preventDefault();
      pointerEvent.stopPropagation();
      this.deactivateInsertMode(runtime);
      void this.openEditor(runtime, {
        initial: { latex: "", mode: "display" },
        title: "\u63d2\u5165 LaTeX \u6570\u5b66\u516c\u5f0f",
        onSave: async (payload) => {
          await this.createAnnotation(runtime, location, payload);
          this.scheduleRender(runtime.reader, true);
        },
      });
    };

    runtime.activeClickHandler = clickHandler;
    runtime.doc.addEventListener("click", clickHandler, true);
    runtime.doc.addEventListener("pointerup", clickHandler, true);
  }

  private deactivateInsertMode(runtime: ReaderRuntime): void {
    runtime.doc.body?.classList.remove(ACTIVE_CLASS);
    if (runtime.activeClickHandler) {
      runtime.doc.removeEventListener(
        "click",
        runtime.activeClickHandler,
        true,
      );
      runtime.doc.removeEventListener(
        "pointerup",
        runtime.activeClickHandler,
        true,
      );
      runtime.activeClickHandler = undefined;
    }
    this.setRuntimeButtonsActive(runtime, false);
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
      this.renderMathAnnotations(runtime);
    }, 50);

    if (repeat) {
      for (const delay of [250, 750, 1500]) {
        runtime.win.setTimeout(() => {
          if (!runtime.disposed) {
            this.renderMathAnnotations(runtime);
          }
        }, delay);
      }
    }
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
        target.closest(`.${RENDER_CLASS}`) ||
        target.closest(`.${SOURCE_CLASS}`) ||
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
    const candidates = docs.flatMap((doc) => {
      this.injectStyles(doc);
      this.removeInlineMathRenderers(doc);
      return this.getAnnotationCandidates(runtime, doc);
    });

    const overlayCount = this.renderManagerOverlays(runtime, docs);
    if (overlayCount > 0) {
      for (const doc of docs) {
        this.hideRawMathElements(doc);
      }
    }
    this.logRenderDiagnostics(runtime, {
      docCount: docs.length,
      domCandidateCount: candidates.length,
      domRenderedCount: 0,
      overlayCount,
    });
  }

  private getPDFPageDocuments(runtime: ReaderRuntime): Document[] {
    return this.getRuntimeDocuments(runtime).filter((doc) =>
      Boolean(doc.querySelector(".page")),
    );
  }

  private removeInlineMathRenderers(doc: Document): void {
    for (const element of [
      ...doc.querySelectorAll<HTMLElement>(`.${RENDER_CLASS}`),
    ]) {
      element.remove();
    }
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
        title: "编辑 LaTeX 数学公式",
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
    const pageRect = page.getBoundingClientRect();
    const x = event.clientX - pageRect.left;
    const y = event.clientY - pageRect.top;
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

  private getAnnotationCandidates(
    runtime: ReaderRuntime,
    doc: Document,
  ): RenderCandidate[] {
    const managerCandidates = this.getManagerAnnotationCandidates(runtime, doc);
    const domCandidates = this.getDOMAnnotationCandidates(doc);
    return [...managerCandidates, ...domCandidates];
  }

  private getManagerAnnotationCandidates(
    runtime: ReaderRuntime,
    doc: Document,
  ): RenderCandidate[] {
    const manager = this.getAnnotationManager(runtime.reader);
    const candidates: RenderCandidate[] = [];

    for (const annotation of manager?._annotations ?? []) {
      const payload = this.parsePayload(
        annotation.text ?? annotation.comment ?? "",
      );
      if (!payload) {
        continue;
      }

      const element = this.findAnnotationElement(doc, annotation);
      if (element) {
        candidates.push({ element, payload });
      }
    }

    return candidates;
  }

  private getDOMAnnotationCandidates(doc: Document): RenderCandidate[] {
    const selector = [
      ".annotationLayer .freeTextAnnotation",
      ".annotationLayer .textWidgetAnnotation",
      ".annotationLayer [data-annotation-id]",
      ".annotationLayer [data-id]",
      ".annotationLayer section",
      ".annotationLayer div",
      ".annotationLayer textarea",
      ".annotationLayer input",
      ".annotationEditorLayer .freeTextEditor",
      ".annotationEditorLayer .textEditor",
      ".annotationEditorLayer [contenteditable='true']",
      ".annotationEditorLayer textarea",
      ".annotationEditorLayer input",
      ".annotationEditorLayer *",
      ".freeTextEditor",
      ".textEditor",
      "[contenteditable='true']",
      ".annotationLayer *",
      "[data-annotation-id]",
      "[data-annotation-key]",
    ].join(",");

    const elements = [
      ...doc.querySelectorAll<HTMLElement>(selector),
      ...this.getElementsWithMathText(doc),
    ];
    const containers = elements
      .map((element) => {
        if (element.classList.contains(RENDER_CLASS)) {
          return null;
        }
        const payload = this.extractPayloadFromElement(element);
        if (!payload) {
          return null;
        }
        return {
          element: this.getAnnotationContainer(element),
          payload,
        };
      })
      .filter((candidate): candidate is RenderCandidate => Boolean(candidate));

    return containers.filter(({ element, payload }, index) => {
      if (element.classList.contains(RENDER_CLASS)) {
        return false;
      }
      return (
        containers.findIndex(
          (candidate) =>
            candidate.element === element &&
            candidate.payload.encoded === payload.encoded,
        ) === index
      );
    });
  }

  private getElementsWithMathText(doc: Document): HTMLElement[] {
    const roots = [
      ...doc.querySelectorAll<HTMLElement>(
        "#viewerContainer,#viewer,.page,.annotationLayer,.annotationEditorLayer",
      ),
    ];
    const searchRoots = roots.length ? roots : [doc.body].filter(Boolean);
    const elements = new Set<HTMLElement>();

    for (const root of searchRoots) {
      for (const field of [
        ...(root.querySelectorAll("textarea,input") as NodeListOf<HTMLElement>),
      ]) {
        const value = this.getTextFieldValue(field);
        if (value && this.parsePayload(value)) {
          elements.add(field);
        }
      }

      const textNodeFilter =
        doc.defaultView?.NodeFilter.SHOW_TEXT ?? NodeFilter.SHOW_TEXT;
      const walker = doc.createTreeWalker(root, textNodeFilter);
      let node = walker.nextNode();
      while (node) {
        const text = node.nodeValue ?? "";
        const parent = node.parentElement;
        if (
          parent &&
          !parent.closest(`.${RENDER_CLASS}`) &&
          !parent.closest(`.${SOURCE_CLASS}`) &&
          this.parsePayload(text)
        ) {
          elements.add(parent as HTMLElement);
        }
        node = walker.nextNode();
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
      element.closest(`.${RENDER_CLASS}`) ||
      element.closest(`.${SOURCE_CLASS}`) ||
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

  private getAnnotationContainer(element: HTMLElement): HTMLElement {
    return (
      (element.closest(
        ".freeTextAnnotation,.textWidgetAnnotation,.freeTextEditor,.textEditor,[data-annotation-id],[data-annotation-key],[data-id],[data-editor-id]",
      ) as HTMLElement | null) ?? element
    );
  }

  private findAnnotationElement(
    doc: Document,
    annotation: _ZoteroTypes.Reader.Annotation,
  ): HTMLElement | undefined {
    const ids = [annotation.id, (annotation as { key?: string }).key].filter(
      (id): id is string => Boolean(id),
    );

    for (const id of ids) {
      const escapedID = this.escapeCSSIdentifier(doc, id);
      const escapedAttribute = this.escapeCSSAttributeValue(id);
      const element = doc.querySelector<HTMLElement>(
        [
          `[data-annotation-id="${escapedAttribute}"]`,
          `[data-annotation-key="${escapedAttribute}"]`,
          `[data-id="${escapedAttribute}"]`,
          `[data-editor-id="${escapedAttribute}"]`,
          `#${escapedID}`,
        ].join(","),
      );
      if (element) {
        return this.getAnnotationContainer(element);
      }
    }

    const payload = this.parsePayload(
      annotation.text ?? annotation.comment ?? "",
    );
    if (!payload) {
      return undefined;
    }

    return this.getDOMAnnotationCandidates(doc).find(
      (candidate) => candidate.payload.encoded === payload.encoded,
    )?.element;
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
    return (manager?._annotations ?? []).filter((annotation) =>
      Boolean(
        annotation.type === "text" &&
        this.parsePayload(annotation.text ?? annotation.comment ?? ""),
      ),
    );
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
    runtime: ReaderRuntime,
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

    element.ondblclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      (
        event as Event & { stopImmediatePropagation?: () => void }
      ).stopImmediatePropagation?.();
      void this.openEditorInDocument(this.getEditorDocument(runtime), {
        initial: { latex: payload.latex, mode: payload.mode },
        title: "编辑 LaTeX 数学公式",
        onSave: async (updatedPayload) => {
          await this.updateManagerAnnotationByID(
            runtime.reader,
            annotation.id,
            updatedPayload,
            element.ownerDocument ?? runtime.doc,
          );
          this.scheduleRender(runtime.reader, true);
        },
      });
    };
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
      domCandidateCount: number;
      domRenderedCount: number;
      overlayCount: number;
    },
  ): void {
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

  private renderMathElement(
    runtime: ReaderRuntime,
    element: HTMLElement,
    payload: MathPayload,
  ): void {
    const doc = element.ownerDocument ?? runtime.doc;
    const renderedColor = this.getReadableColor(element);
    let source = element.querySelector<HTMLElement>(
      `:scope > .${SOURCE_CLASS}`,
    );
    if (!source) {
      source = doc.createElement("span");
      source.className = SOURCE_CLASS;
      element.appendChild(source);
    }
    source.textContent = payload.encoded;

    let wrapper = element.querySelector<HTMLElement>(
      `:scope > .${RENDER_CLASS}`,
    );
    if (!wrapper) {
      wrapper = doc.createElement("span");
      wrapper.className = RENDER_CLASS;
      wrapper.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.editRenderedAnnotation(runtime, element);
      });
      element.appendChild(wrapper);
    }

    wrapper.classList.toggle("is-display", payload.mode === "display");
    wrapper.classList.toggle("is-inline", payload.mode === "inline");
    wrapper.dataset.mathMode = payload.mode;
    wrapper.dataset.mathSource = payload.latex;
    wrapper.style.color = renderedColor;
    element.style.setProperty("--zotero-latex-math-color", renderedColor);
    wrapper.innerHTML = this.renderLatex(payload.latex, payload.mode);
    this.hideRawMathText(element);

    const computedElementStyle =
      element.ownerDocument?.defaultView?.getComputedStyle(element);
    if (computedElementStyle?.position === "static") {
      element.style.position = "relative";
    }
    element.classList.add("zotero-latex-math-annotation");
    element.dataset.mathMode = payload.mode;
    element.dataset.mathSource = payload.latex;
  }

  private hideRawMathText(element: HTMLElement): void {
    for (const child of [...element.children]) {
      const childElement = child as HTMLElement;
      if (
        childElement.classList.contains(RENDER_CLASS) ||
        childElement.classList.contains(SOURCE_CLASS)
      ) {
        continue;
      }
      childElement.dataset.zoteroLatexMathHidden = "true";
    }

    for (const field of [
      ...element.querySelectorAll<HTMLElement>(
        "textarea,input,[contenteditable='true']",
      ),
    ]) {
      if (
        field.closest(`.${RENDER_CLASS}`) ||
        field.closest(`.${SOURCE_CLASS}`)
      ) {
        continue;
      }
      field.dataset.zoteroLatexMathHidden = "true";
      field.setAttribute("aria-hidden", "true");
    }
  }

  private async editRenderedAnnotation(
    runtime: ReaderRuntime,
    element: HTMLElement,
  ): Promise<void> {
    const source = this.extractPayloadFromElement(element);
    if (!source) {
      return;
    }

    await this.openEditor(runtime, {
      initial: { latex: source.latex, mode: source.mode },
      title: "编辑 LaTeX 数学公式",
      onSave: async (payload) => {
        await this.updateAnnotation(runtime, element, payload.encoded);
        this.renderMathElement(runtime, element, payload);
      },
    });
  }

  private async openEditor(
    runtime: ReaderRuntime,
    options: {
      title: string;
      initial: { latex: string; mode: MathMode };
      onSave: (payload: MathPayload) => Promise<void> | void;
    },
  ): Promise<void> {
    return this.openEditorInDocument(this.getEditorDocument(runtime), options);
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
    modeText.textContent = "\u5927\u516c\u5f0f\u6a21\u5f0f (Display Mode)";
    modeLabel.append(displayMode, modeText);

    const actions = create("div");
    actions.className = "zotero-latex-math-actions";

    const cancel = create("button");
    cancel.type = "button";
    cancel.textContent = "\u53d6\u6d88";

    const save = create("button");
    save.type = "button";
    save.className = "primary";
    save.textContent = options.initial.latex ? "\u4fdd\u5b58" : "\u63d2\u5165";

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
        : "\u8f93\u5165 LaTeX \u540e\u5728\u8fd9\u91cc\u9884\u89c8";
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

  private async createAnnotation(
    runtime: ReaderRuntime,
    location: ClickLocation,
    payload: MathPayload,
  ): Promise<void> {
    const manager = this.getAnnotationManager(runtime.reader);
    if (!manager?.addAnnotation) {
      throw new Error("Reader annotation manager is not available");
    }

    await this.createAnnotationWithManager(
      manager,
      location,
      payload,
      runtime.doc,
    );
  }

  private async createAnnotationWithManager(
    manager: AnnotationManager,
    location: ClickLocation,
    payload: MathPayload,
    doc?: Document,
  ): Promise<void> {
    const fontSize = 14;
    const rect =
      doc && payload.renderedSize
        ? this.resizeLocationRect(doc, location, payload.renderedSize)
        : location.rect;
    const rawAnnotation = {
      id: manager._generateObjectKey?.() ?? Zotero.Utilities.randomString(8),
      type: "text",
      color: "#000000",
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

  private async updateAnnotation(
    runtime: ReaderRuntime,
    element: HTMLElement,
    encoded: string,
  ): Promise<void> {
    const manager = this.getAnnotationManager(runtime.reader);
    const annotation = this.findAnnotation(runtime.reader, element);
    if (annotation && manager) {
      annotation.text = encoded;
      annotation.dateModified = new Date().toISOString();
      manager.updateAnnotations?.(
        this.replaceManagedAnnotation(manager, annotation),
      );
      manager._save?.(annotation, true);
      return;
    }

    const item = this.findAnnotationItem(runtime.reader, element);
    if (item) {
      item.annotationText = encoded;
      await item.saveTx();
      runtime.reader.setAnnotations([item]);
      return;
    }

    throw new Error("Unable to resolve the underlying Zotero annotation");
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

  private findAnnotation(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    element: HTMLElement,
  ): _ZoteroTypes.Reader.Annotation | undefined {
    const manager = this.getAnnotationManager(reader);
    const annotationID = this.getAnnotationID(element);
    if (annotationID) {
      const byID = manager?._getAnnotationByID?.(annotationID);
      if (byID) {
        return byID;
      }
    }

    const source = this.getSourceText(element);
    return manager?._annotations?.find(
      (annotation) => annotation.text === source,
    );
  }

  private findAnnotationItem(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    element: HTMLElement,
  ): Zotero.Item | undefined {
    const annotationID = this.getAnnotationID(element);
    const itemIDs = reader.annotationItemIDs ?? [];
    for (const itemID of itemIDs) {
      const item = Zotero.Items.get(itemID);
      if (!item) {
        continue;
      }

      const readerAnnotation = reader._getAnnotation(item);
      if (
        readerAnnotation?.id === annotationID ||
        item.key === annotationID ||
        item.annotationText === this.getSourceText(element)
      ) {
        return item;
      }
    }
    return undefined;
  }

  private getClickLocation(
    runtime: ReaderRuntime,
    event: MouseEvent,
  ): ClickLocation | undefined {
    const target = event.target as Element | null;
    const page =
      (target?.closest(".page") as HTMLElement | null | undefined) ??
      this.getCurrentPageElement(runtime);
    if (!page) {
      return undefined;
    }

    const pageIndex = this.getPageIndex(runtime.doc, page);
    const pageRect = page.getBoundingClientRect();
    const x = Math.max(0, event.clientX - pageRect.left);
    const y = Math.max(0, event.clientY - pageRect.top);
    const width = 220;
    const height = 48;
    const viewport = this.getPDFViewport(runtime, pageIndex);

    if (viewport?.convertToPdfPoint) {
      const start = viewport.convertToPdfPoint(x, y);
      const end = viewport.convertToPdfPoint(x + width, y + height);
      return {
        pageIndex,
        rect: [start[0], start[1], end[0], end[1]],
      };
    }

    return { pageIndex, rect: [x, y, x + width, y + height] };
  }

  private getClickLocationFromDocument(
    doc: Document,
    event: MouseEvent,
  ): ClickLocation | undefined {
    const target = event.target as Element | null;
    const page =
      (target?.closest(".page") as HTMLElement | null | undefined) ??
      (doc.elementFromPoint(event.clientX, event.clientY)?.closest(".page") as
        | HTMLElement
        | null
        | undefined) ??
      doc.querySelector<HTMLElement>(".page");
    if (!page) {
      return undefined;
    }

    const pageIndex = this.getPageIndex(doc, page);
    const pageRect = page.getBoundingClientRect();
    const x = Math.max(0, event.clientX - pageRect.left);
    const y = Math.max(0, event.clientY - pageRect.top);
    const width = 220;
    const height = 48;
    const viewport = this.getPDFViewportFromWindow(doc.defaultView, pageIndex);

    if (viewport?.convertToPdfPoint) {
      const start = viewport.convertToPdfPoint(x, y);
      const end = viewport.convertToPdfPoint(x + width, y + height);
      return {
        pageIndex,
        rect: [start[0], start[1], end[0], end[1]],
      };
    }

    return { pageIndex, rect: [x, y, x + width, y + height] };
  }

  private getCurrentPageElement(runtime: ReaderRuntime): HTMLElement | null {
    const app = (runtime.win as any).PDFViewerApplication;
    const currentPageNumber = app?.pdfViewer?.currentPageNumber;
    if (Number.isFinite(currentPageNumber)) {
      const page = runtime.doc.querySelector<HTMLElement>(
        `.page[data-page-number="${currentPageNumber}"]`,
      );
      if (page) {
        return page;
      }
    }

    return runtime.doc.querySelector<HTMLElement>(".page");
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

  private getPDFViewportFromWindow(
    win: Window | null,
    pageIndex: number,
  ): Viewport | undefined {
    const app = (win as any)?.PDFViewerApplication;
    return app?.pdfViewer?.getPageView?.(pageIndex)?.viewport;
  }

  private getAnnotationID(element: HTMLElement): string | undefined {
    const annotated = element.closest(
      "[data-annotation-id],[data-annotation-key],[data-id]",
    ) as HTMLElement | null;
    return (
      annotated?.dataset.annotationId ||
      annotated?.dataset.annotationKey ||
      annotated?.dataset.id ||
      element.id ||
      undefined
    );
  }

  private getSourceText(element: HTMLElement): string {
    const ownValue = this.getTextFieldValue(element);
    if (ownValue) {
      return ownValue.trim();
    }

    const source = element.querySelector<HTMLElement>(
      `:scope > .${SOURCE_CLASS}`,
    );
    if (source?.textContent) {
      return source.textContent.trim();
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
      element.querySelector<HTMLElement>(`:scope > .${SOURCE_CLASS}`)
        ?.textContent ||
      element.getAttribute("data-math-encoded") ||
      this.getSourceText(element);
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
  ): number[] {
    const viewport = this.getPDFViewportFromWindow(
      doc.defaultView,
      location.pageIndex,
    );
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
    return [start[0], start[1], end[0], end[1]];
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
    );
    const annotationPosition = annotation.position as {
      rects?: number[][];
    };
    annotationPosition.rects = this.cloneIntoManagerRealm(manager, [
      resized.map((value) => Number(value)),
    ]);
  }

  private estimateFontSizeFromRect(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    doc: Document,
    pageIndex: number,
    rect: number[],
  ): number {
    const runtime = this.runtimes.get(reader);
    const viewportRect = runtime
      ? this.getViewportRect(runtime, doc, pageIndex, rect)
      : undefined;
    return this.clamp(Math.round((viewportRect?.height ?? 48) * 0.42), 8, 72);
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

  private ensurePointerTool(reader: _ZoteroTypes.ReaderInstance<"pdf">): void {
    this.setNativeTool(reader, { type: "pointer" });
  }

  private setNativeTool(
    reader: _ZoteroTypes.ReaderInstance<"pdf">,
    tool: { type: string; color?: string },
  ): void {
    const internalReader = reader._internalReader as any;
    if (typeof internalReader?.setTool === "function") {
      internalReader.setTool(tool);
      return;
    }

    if (internalReader?._state) {
      internalReader._state.tool = tool;
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

  private getReadableColor(element: HTMLElement): string {
    const view = element.ownerDocument?.defaultView;
    const candidates = [
      ...element.querySelectorAll<HTMLElement>(
        "textarea,input,[contenteditable='true'],span,div",
      ),
      element,
    ];

    for (const candidate of candidates) {
      if (
        candidate.classList.contains(RENDER_CLASS) ||
        candidate.classList.contains(SOURCE_CLASS)
      ) {
        continue;
      }

      const color = view?.getComputedStyle(candidate)?.color;
      if (color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)") {
        return color;
      }
    }

    return "#111111";
  }

  private disposeRuntime(runtime: ReaderRuntime): void {
    runtime.disposed = true;
    this.deactivateInsertMode(runtime);
    for (const observer of runtime.observers) {
      observer.disconnect();
    }
    runtime.observers = [];
    for (const cleanup of runtime.documentCleanups) {
      cleanup();
    }
    runtime.documentCleanups = [];
    runtime.observedDocs.clear();
    runtime.win.removeEventListener("resize", runtime.resizeHandler);
    if (runtime.renderTimer) {
      runtime.win.clearTimeout(runtime.renderTimer);
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

  private escapeCSSIdentifier(doc: Document, value: string): string {
    const escape = doc.defaultView?.CSS?.escape;
    if (escape) {
      return escape(value);
    }

    return value.replaceAll(/[^a-zA-Z0-9_-]/g, "\\$&");
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
