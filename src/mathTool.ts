/**
 * 插件门面：只做生命周期接线，具体逻辑按职责放在 `src/math/` 的各模块里。
 *
 * 对外仍是 `LatexMathTool`（`Zotero.MathTool` 单例），方法签名保持不变，供
 * `src/hooks.ts` 在 startup / shutdown / 主窗口关闭时调用。
 */

import { disposeRuntime } from "./math/dispose";
import { startToolbarIntegration, stopToolbarIntegration } from "./math/insert";
import { ensureReader } from "./math/readerInit";
import { state } from "./math/state";

export class LatexMathTool {
  public startup(): void {
    startToolbarIntegration(ensureReader);

    for (const reader of Zotero.Reader._readers ?? []) {
      if (reader.type === "pdf") {
        void ensureReader(reader as _ZoteroTypes.ReaderInstance<"pdf">);
      }
    }
  }

  public shutdown(): void {
    stopToolbarIntegration();

    for (const runtime of [...state.runtimeSet]) {
      disposeRuntime(runtime);
    }
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
