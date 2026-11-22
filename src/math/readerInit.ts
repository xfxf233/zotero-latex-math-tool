/**
 * reader 初始化入口：幂等 ensureReader（并发去重）与 runtime 建立。
 *
 * 初始化可能被"插件已 shutdown"或"reader 已关闭"打断：`_waitForReader` 与
 * `primaryView.initializedPromise` 都可能永不 settle（见
 * .agents/notes/reader-init-race.md），所以每个等待都与取消信号 race；命中后抛
 * `ReaderInitCancelled`，由调用方的 `logReaderInitError` 过滤掉。
 *
 * runtime 建立顺序（等待 reader/iframe → patch 管理器 → 注册 runtime → 观察文档 →
 * 首轮渲染）是行为的一部分，改动前先看 docs/architecture.md。
 */
import { getAnnotationManager } from "./annotationData";
import { ensureAnnotationMetadata } from "./annotations";
import { patchAnnotationManager, patchReaderUninit } from "./patches";
import { waitForPDFWindow } from "./readerDocs";
import { ReaderInitCancelled } from "./readerInitCancel";
import { refreshObservedDocuments, scheduleRender } from "./renderer";
import { state } from "./state";
import type { ReaderRuntime } from "./types";

const PDF_WINDOW_TIMEOUT = 15000;

interface InitAbort {
  cancelled: boolean;
  /**
   * 取消时 resolve。不用 reject：取消后可能没人再等这个 promise，reject 会变成
   * 未处理 rejection。
   */
  promise: Promise<void>;
  cancel: () => void;
}

export async function ensureReader(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
): Promise<ReaderRuntime> {
  // 关闭/禁用后仍可能有晚到的调用（编辑器保存回调等）：不启动初始化，也不报错。
  if (isInitCancelled(reader)) {
    throw new ReaderInitCancelled();
  }

  const existing = state.runtimes.get(reader);
  if (
    existing &&
    !existing.disposed &&
    !Components.utils.isDeadWrapper(existing.win)
  ) {
    return existing;
  }

  // 并发去重：startup 遍历已打开的 reader 与 renderToolbar 事件可能同时触发
  // 同一 reader 的初始化。若各自完整建流程，会建出两个 runtime（后写覆盖
  // 先写），先建 runtime 的 MutationObserver / resize 监听成为孤儿、回调成
  // 双份。共享同一个 in-flight Promise，并发调用等待同一结果。
  const inFlight = state.ensureReaderPromises.get(reader);
  if (inFlight) {
    return inFlight;
  }
  const promise = initializeReaderRuntime(reader).finally(() => {
    state.ensureReaderPromises.delete(reader);
  });
  state.ensureReaderPromises.set(reader, promise);
  return promise;
}

async function initializeReaderRuntime(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
): Promise<ReaderRuntime> {
  // uninit 包装必须早于第一个 await：初始化进行中关掉 reader 时，它是唯一的关闭
  // 信号。没有 runtime 时包装只做标记并取消，不做清理。
  patchReaderUninit(reader);

  const abort = createInitAbort();
  state.readerInitAborts.set(reader, abort.cancel);
  try {
    await waitAbortable(abort, reader._waitForReader?.());
    throwIfInitCancelled(reader, abort);

    const primaryView = getPrimaryView(reader);
    await waitAbortable(abort, getInitializedPromise(primaryView));
    throwIfInitCancelled(reader, abort);

    const win = await waitForPDFWindow(
      reader,
      PDF_WINDOW_TIMEOUT,
      () => abort.cancelled || isInitCancelled(reader),
    );
    throwIfInitCancelled(reader, abort);
    if (!win?.document?.body) {
      throw new Error("PDF iframe window is not ready");
    }

    const manager = getAnnotationManager(reader);
    if (manager) {
      patchAnnotationManager(reader, manager);
    }

    const resizeHandler = () => scheduleRender(reader);
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

    state.runtimes.set(reader, runtime);
    state.runtimeSet.add(runtime);
    ensureAnnotationMetadata(reader);
    refreshObservedDocuments(runtime);
    scheduleRender(reader);

    return runtime;
  } finally {
    // 只删自己登记的那一条：期间若又登记了新初始化（map 已换值），别误删。
    if (state.readerInitAborts.get(reader) === abort.cancel) {
      state.readerInitAborts.delete(reader);
    }
  }
}

function createInitAbort(): InitAbort {
  let resolveAbort!: () => void;
  const abort: InitAbort = {
    cancelled: false,
    promise: new Promise<void>((resolve) => {
      resolveAbort = resolve;
    }),
    cancel: () => {
      if (abort.cancelled) {
        return;
      }
      abort.cancelled = true;
      resolveAbort();
    },
  };
  return abort;
}

/**
 * 等待一个 Zotero promise，期间可被取消。`Promise.race` 会给落选的 promise 挂
 * 处理器，所以取消后它再 reject 也不会变成未处理 rejection。
 */
async function waitAbortable<T>(
  abort: InitAbort,
  promise: Promise<T> | undefined,
): Promise<T | undefined> {
  if (!promise) {
    return undefined;
  }
  const value = await Promise.race([promise, abort.promise]);
  if (abort.cancelled) {
    throw new ReaderInitCancelled();
  }
  return value as T;
}

function throwIfInitCancelled(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
  abort: InitAbort,
): void {
  if (abort.cancelled || isInitCancelled(reader)) {
    throw new ReaderInitCancelled();
  }
}

/**
 * 关闭/禁用判定。两个来源缺一不可：uninit 包装（`closedReaders`）只覆盖包装已经
 * 装上的情况；Zotero 的 `ReaderInstance.uninit()` 不清 `_iframeWindow`，关得更早
 * 时窗口会变成死 wrapper，只能靠 `isDeadWrapper` 发现。
 */
function isInitCancelled(reader: _ZoteroTypes.ReaderInstance<"pdf">): boolean {
  if (!state.alive || state.closedReaders.has(reader)) {
    return true;
  }
  try {
    const win = reader._iframeWindow;
    return Boolean(win) && Components.utils.isDeadWrapper(win);
  } catch {
    return true;
  }
}

/**
 * 关闭中的 reader 的 `_internalReader` / `_primaryView` 可能是死 wrapper，直接读属性会
 * 抛 NS_ERROR；读失败按"已关闭"处理。
 */
function getPrimaryView(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
): { initializedPromise?: Promise<unknown> } | undefined {
  try {
    const internal = reader._internalReader;
    if (!internal) {
      return undefined;
    }
    return internal._primaryView as
      { initializedPromise?: Promise<unknown> } | undefined;
  } catch {
    throw new ReaderInitCancelled();
  }
}

function getInitializedPromise(
  primaryView: { initializedPromise?: Promise<unknown> } | undefined,
): Promise<unknown> | undefined {
  try {
    return primaryView?.initializedPromise;
  } catch {
    throw new ReaderInitCancelled();
  }
}
