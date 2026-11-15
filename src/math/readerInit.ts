/**
 * reader 初始化入口：幂等 ensureReader（并发去重）与 runtime 建立。
 *
 * runtime 建立顺序（等待 reader/iframe → patch 管理器 → 注册 runtime → 观察文档 →
 * 首轮渲染）是行为的一部分，改动前先看 docs/architecture.md。
 */
import { getAnnotationManager } from "./annotationData";
import { ensureAnnotationMetadata } from "./annotations";
import { patchAnnotationManager, patchReaderUninit } from "./patches";
import { waitForPDFWindow } from "./readerDocs";
import { refreshObservedDocuments, scheduleRender } from "./renderer";
import { state } from "./state";
import type { ReaderRuntime } from "./types";

export async function ensureReader(
  reader: _ZoteroTypes.ReaderInstance<"pdf">,
): Promise<ReaderRuntime> {
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
  await reader._waitForReader?.();
  const primaryView = reader._internalReader?._primaryView;
  await primaryView?.initializedPromise?.catch(() => undefined);

  const win = await waitForPDFWindow(reader);
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
  patchReaderUninit(reader);
  ensureAnnotationMetadata(reader);
  refreshObservedDocuments(runtime);
  scheduleRender(reader);

  return runtime;
}
