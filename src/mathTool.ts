/**
 * 插件门面：只做生命周期接线，具体逻辑按职责放在 `src/math/` 的各模块里。
 *
 * 对外仍是 `LatexMathTool`（`Zotero.MathTool` 单例），方法签名保持不变，供
 * `src/hooks.ts` 在 startup / shutdown / 主窗口关闭时调用。
 */

import {
  disposeRuntime,
  removePageResidue,
  removeToolbarStylesFromOpenReaders,
} from "./math/dispose";
import { startToolbarIntegration, stopToolbarIntegration } from "./math/insert";
import { ensureReader } from "./math/readerInit";
import { logReaderInitError } from "./math/readerInitCancel";
import { state } from "./math/state";

export class LatexMathTool {
  public startup(): void {
    startToolbarIntegration(ensureReader);

    for (const reader of Zotero.Reader._readers ?? []) {
      if (reader.type === "pdf") {
        void ensureReader(reader as _ZoteroTypes.ReaderInstance<"pdf">).catch(
          (error) => logReaderInitError("Unable to initialize reader", error),
        );
      }
    }
  }

  public shutdown(): void {
    stopToolbarIntegration();
    // 先让补丁短路：shutdown 之后 Zotero 仍可能回调 annotationManager 与 view 的包装
    // （拖拽、外部更新），不能再用旧沙箱的代码改页面或标注。
    state.alive = false;
    // 取消 in-flight 初始化：它们可能正等在一个永不 settle 的 promise 上，不取消会
    // 在禁用后继续建 runtime、改页面（见 reader-init-race 那篇 note）。
    for (const abort of [...state.readerInitAborts.values()]) {
      abort();
    }
    state.readerInitAborts.clear();
    // 释放挂起初始化对 reader 的强引用；取消本身由上面的 abort 负责。
    state.ensureReaderPromises.clear();
    for (const runtime of [...state.runtimeSet]) {
      // 插件禁用、reader 仍开着：overlay 与原文隐藏状态不会随样式表消失，必须显式清。
      removePageResidue(runtime);
      disposeRuntime(runtime);
    }
    removeToolbarStylesFromOpenReaders();
    state.runtimeSet.clear();
  }

  public disposeWindow(win: Window): void {
    for (const runtime of [...state.runtimeSet]) {
      // reader 关闭过程中 runtime.win 可能是已销毁的死 wrapper，访问其属性会
      // 抛 NS_ERROR、中断整个清理循环，导致其余 runtime 的监听器残留。任何
      // 死 wrapper 访问都短路跳过该 runtime（其自身清理由 disposeRuntime 兜底）。
      let matches: boolean;
      try {
        matches =
          win === runtime.reader._window ||
          win === runtime.win ||
          win === runtime.win.top;
      } catch {
        matches = false;
      }
      if (matches) {
        disposeRuntime(runtime);
      }
    }
  }
}
