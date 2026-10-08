/**
 * A stand-in for the `electron` module in `node --test`.
 *
 * The main-process modules under test import `dialog` and `shell` at module
 * scope. Node has no Electron, so the bare specifier is redirected here; the
 * tests that use this never open a dialog or reveal a folder, and a channel that
 * unexpectedly needs one fails loudly instead of passing quietly.
 */
function notInNode(name) {
  return () => {
    throw new Error(`${name} is not available outside Electron`);
  };
}

export const dialog = {
  showSaveDialog: notInNode("dialog.showSaveDialog"),
};

export const shell = {
  showItemInFolder: notInNode("shell.showItemInFolder"),
};
