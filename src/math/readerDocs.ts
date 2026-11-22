/**
 * reader 内文档/iframe 的发现与等待：找 PDF 窗口、收集要观察的文档、按 reader 读回
 * 工具栏文档（写入在 insert.ts 的 renderToolbar 处理里）。
 *
 * 编辑器 iframe 必须排除在渲染观察之外，否则每次打开编辑器都会泄漏 observer。
 */
import { EDITOR_FRAME_CLASS } from "./constants";
import { state } from "./state";
import type { ReaderRuntime } from "./types";

export function collectReaderDocuments(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
): Document[] {
  const readerAny = reader as any;
  const docs = [
    state.readerDocs.get(reader),
    readerAny._iframeWindow?.document,
    readerAny._iframe?.contentDocument,
    readerAny._internalReader?._primaryView?._iframeWindow?.document,
    readerAny._internalReader?._primaryView?._iframe?.contentDocument,
  ].filter((doc): doc is Document => Boolean(doc?.body));

  const nestedDocs = docs.flatMap((doc) =>
    getNestedFrameWindows(doc).map((win) => win.document),
  );

  return [...new Set([...docs, ...nestedDocs])];
}

export function getRuntimeDocuments(runtime: ReaderRuntime): Document[] {
  const docs = [runtime.doc, ...collectReaderDocuments(runtime.reader)].filter(
    (doc): doc is Document => Boolean(doc?.body),
  );

  return [...new Set(docs)].filter((doc) => {
    // 编辑器 iframe 是临时 UI，不是 PDF 页面文档。排除它，避免每次打开
    // 编辑器都被 refreshObservedDocuments 观察并留下一个永不释放的
    // MutationObserver/Document 引用（长时间会话会随编辑次数累积）。
    try {
      const frame = doc.defaultView?.frameElement;
      if (frame?.classList?.contains(EDITOR_FRAME_CLASS)) {
        return false;
      }
    } catch {
      // frameElement 跨 realm 访问失败时按普通文档继续走原有过滤。
    }

    try {
      return !Components.utils.isDeadWrapper(doc.defaultView ?? doc);
    } catch {
      return false;
    }
  });
}

export function getPDFPageDocuments(runtime: ReaderRuntime): Document[] {
  return getRuntimeDocuments(runtime).filter((doc) =>
    Boolean(doc.querySelector(".page")),
  );
}

export async function waitForPDFWindow(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  timeout = 15000,
  shouldAbort?: () => boolean,
): Promise<Window | undefined> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    // reader 关闭或插件卸载时立即返回，否则要空转到超时；返回 undefined 由调用方
    // 按取消处理。
    if (shouldAbort?.()) {
      return undefined;
    }
    const win = getPDFWindow(reader);
    if (win?.document?.body) {
      return win;
    }
    await Zotero.Promise.delay(100);
  }
  return shouldAbort?.() ? undefined : getPDFWindow(reader);
}

function getPDFWindow(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
): Window | undefined {
  try {
    const readerAny = reader as any;
    const primaryView = readerAny._internalReader?._primaryView;
    const candidates = [
      primaryView?._iframeWindow,
      primaryView?._iframe?.contentWindow,
      readerAny._iframeWindow,
      readerAny._iframe?.contentWindow,
      state.readerDocs.get(reader)?.defaultView,
      ...getNestedFrameWindows(primaryView?._iframeWindow?.document),
      ...getNestedFrameWindows(readerAny._iframeWindow?.document),
      ...getNestedFrameWindows(state.readerDocs.get(reader)),
    ].filter((win): win is Window => Boolean(win?.document?.body));

    return candidates.find((win) => isPDFCanvasWindow(win));
  } catch {
    // reader 关闭过程中 cross-compartment wrapper 可能已经死掉，读属性会抛
    // NS_ERROR。按"这一轮没找到"处理，由调用方的中止谓词决定是否继续等。
    return undefined;
  }
}

function getNestedFrameWindows(
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
    getNestedFrameWindows(win.document, seen),
  );

  return [...windows, ...nested];
}

function isPDFCanvasWindow(win: Window): boolean {
  return Boolean(
    (win as any).PDFViewerApplication ||
    win.document.querySelector(".page") ||
    win.document.querySelector("#viewerContainer"),
  );
}
