/** 拆分后的 plugin 层共享类型。只放跨模块使用的类型，不放逻辑。 */

export type ClickLocation = {
  pageIndex: number;
  rect: number[];
};

export type FormulaSize = {
  width: number;
  height: number;
};

export type Viewport = {
  convertToPdfPoint?: (x: number, y: number) => number[];
  convertToViewportRectangle?: (rect: number[]) => number[];
  width?: number;
  height?: number;
  scale?: number;
};

export type ViewportRect = {
  left: number;
  top: number;
  width: number;
  height: number;
  scale?: number;
};

/** 一个 PDF reader 的渲染运行时：窗口、观察器和清理句柄都挂在这里。 */
export type ReaderRuntime = {
  reader: _ZoteroTypes.ReaderInstance<"pdf">;
  win: Window;
  doc: Document;
  observers: MutationObserver[];
  observedDocs: Set<Document>;
  documentCleanups: Array<() => void>;
  resizeHandler: EventListener;
  renderTimer?: number;
  repeatTimer?: number;
  toolMonitorTimer?: number;
  lastScale?: number;
  syncRAF?: number;
  disposed: boolean;
};

export type AnnotationManager = _ZoteroTypes.Reader.AnnotationManager & {
  _getAnnotationByID?: (id: string) => _ZoteroTypes.Reader.Annotation;
  _save?: (
    annotation: _ZoteroTypes.Reader.Annotation,
    instant?: boolean,
  ) => void;
};

/** PDF view 上负责把文本标注 rect 对齐到内容的内部方法。 */
export type AdjustablePDFView = {
  adjustTextAnnotationPosition?: (
    annotation: unknown,
    options?: Record<string, unknown>,
  ) => unknown;
};
