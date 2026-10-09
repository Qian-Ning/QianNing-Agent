/**
 * A stand-in for the `electron` module in `node --test`.
 *
 * The main-process modules under test import `dialog` and `shell` at module
 * scope. Node has no Electron, so the bare specifier is redirected here. A
 * channel that would open a dialog or reveal a file still fails loudly instead
 * of passing quietly — but the library removal channels are exercised for real,
 * so `trashItem` and `openPath` record what they were handed in the exported
 * arrays and resolve, letting a test assert which files were reclaimed.
 */
function notInNode(name) {
  return () => {
    throw new Error(`${name} is not available outside Electron`);
  };
}

/** Paths handed to `shell.trashItem`, in call order. */
export const trashed = [];
/** Paths handed to `shell.openPath`, in call order. */
export const opened = [];

export const dialog = {
  showSaveDialog: notInNode("dialog.showSaveDialog"),
};

export const shell = {
  showItemInFolder: notInNode("shell.showItemInFolder"),
  trashItem: async (path) => {
    trashed.push(path);
  },
  openPath: async (path) => {
    opened.push(path);
    return "";
  },
};
