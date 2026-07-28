import { LatexMathTool } from "./mathTool";
import { initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  addon.data.mathTool = new LatexMathTool();
  addon.data.mathTool.startup();

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  addon.data.mathTool?.disposeWindow(_win);
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  addon.data.mathTool?.shutdown();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};
