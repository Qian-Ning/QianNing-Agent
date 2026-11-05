/**
 * What the Android back gesture means on the phone surface.
 *
 * The Activity asks the web layer first (`window.__qianningBack`) and only then
 * decides what the system does, so this function owns the order: an overlay
 * closes before the screen behind it changes, and the session list is the one
 * place where back leaves the app (the Activity sends it to the background
 * rather than finishing it).
 */
export type BackScreen = "sessions" | "chat" | "settings" | "terminal";

export interface BackState {
  drawerOpen: boolean;
  browserOpen: boolean;
  modelOpen: boolean;
  setupOpen: boolean;
  screen: BackScreen;
}

export type BackDecision =
  | { handled: true; close: "drawer" | "browser" | "model" | "setup" }
  | { handled: true; screen: BackScreen }
  | { handled: false };

/**
 * Topmost first: sheets sit above the screen that opened them, so closing one
 * must not also navigate.
 */
export function decideBack(state: BackState): BackDecision {
  if (state.drawerOpen) return { handled: true, close: "drawer" };
  if (state.browserOpen) return { handled: true, close: "browser" };
  if (state.modelOpen) return { handled: true, close: "model" };
  if (state.setupOpen) return { handled: true, close: "setup" };
  if (state.screen !== "sessions") return { handled: true, screen: "sessions" };
  return { handled: false };
}
