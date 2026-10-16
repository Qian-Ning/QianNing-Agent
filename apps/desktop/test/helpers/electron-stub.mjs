/**
 * A stand-in for the `electron` module in `node --test`.
 *
 * The main-process modules under test import `dialog`, `shell`, `nativeImage`
 * and the outbound-proxy surfaces (`app`, `net`, `session`) at module scope.
 * Node has no Electron, so the bare specifier is redirected
 * here. A channel that would open a dialog or reveal a file still fails loudly
 * instead of passing quietly — but the library removal channels are exercised for
 * real, so `trashItem` and `openPath` record what they were handed in the
 * exported arrays and resolve, letting a test assert which files were reclaimed.
 */
import { existsSync } from "node:fs";

function notInNode(name) {
  return () => {
    throw new Error(`${name} is not available outside Electron`);
  };
}

/** Paths handed to `shell.trashItem`, in call order. */
export const trashed = [];
/** Paths handed to `shell.openPath`, in call order. */
export const opened = [];
/** Paths handed to `nativeImage.createFromPath`, in call order. */
export const decoded = [];

/**
 * One shared 1x1 PNG, standing in for a decoded image.
 *
 * Small, valid, and plainly not the bytes of any render a test writes, which is
 * everything a test needs to tell a derived copy from the file it came from.
 */
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9mQAAAAASUVORK5CYII=",
  "base64",
);

/**
 * The outbound-proxy module's Electron surfaces.
 *
 * `app.on`, `net.fetch` and the `session` accessors are only reached while a
 * proxy is applied or tested, and every test that cares about a proxy replaces
 * the relay (or the whole apply call) with its own stand-in. Anything that does
 * arrive here therefore fails loudly rather than answering with a guess — the
 * same rule the dialog and reveal channels below follow.
 */
export const app = {
  on: notInNode("app.on"),
};

export const net = {
  fetch: notInNode("net.fetch"),
};

export const session = {
  defaultSession: {
    resolveProxy: notInNode("session.defaultSession.resolveProxy"),
    setProxy: notInNode("session.defaultSession.setProxy"),
  },
  fromPartition: notInNode("session.fromPartition"),
};

export const dialog = {
  showSaveDialog: notInNode("dialog.showSaveDialog"),
};

/**
 * The window class. `BrowserWindow` is a value import in the main-process
 * modules that open a native picker, so the module scope needs the name to
 * exist; reaching it still fails loudly.
 */
export const BrowserWindow = {
  fromWebContents: notInNode("BrowserWindow.fromWebContents"),
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

/**
 * The image decoder, faked down to what the app uses of it.
 *
 * The decoder reads the file, so "a path that names nothing decodes to nothing"
 * stays true here rather than being papered over — that case is why a row with no
 * copy falls back to the render. A decoded image resizes to itself at any width
 * and encodes to the shared pixel, so a written copy is a real, readable PNG.
 */
export const nativeImage = {
  createFromPath: (path) => {
    decoded.push(path);
    const present = existsSync(path);
    return {
      isEmpty: () => !present,
      resize: () => ({ isEmpty: () => !present, toPNG: () => onePixelPng }),
    };
  },
};
