export { createZToolkit, getGlobal };

/**
 * Look up a global from the plugin sandbox, falling back to the Zotero main window.
 *
 * This mirrors what `BasicTool.getGlobal` from `zotero-plugin-toolkit` did. The plugin
 * only ever needs `Zotero` and `Localization`, so the dependency is not worth keeping.
 */
function getGlobal(name: string): any {
  const sandbox = globalThis as unknown as Record<string, any>;
  if (typeof sandbox[name] !== "undefined") {
    return sandbox[name];
  }
  const win = Zotero.getMainWindow() as unknown as Record<string, any> | null;
  switch (name) {
    case "Zotero":
    case "zotero":
      return Zotero;
    case "window":
      return win;
    case "document":
      return win?.document;
    default:
      return win?.[name];
  }
}

/**
 * Minimal replacement for `ZoteroToolkit`.
 *
 * Only the pieces the plugin actually used are kept. `unregisterAll` is a no-op because
 * nothing is registered through the toolkit: every listener and UI element in the plugin
 * is created and torn down with native Zotero APIs.
 */
function createZToolkit() {
  return {
    getGlobal,
    unregisterAll() {
      // Intentionally empty: nothing was ever registered with the toolkit.
    },
  };
}
