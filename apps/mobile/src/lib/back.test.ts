import { describe, expect, it } from "vitest";

import { decideBack, type BackState } from "./back";

const base: BackState = {
  drawerOpen: false,
  browserOpen: false,
  modelOpen: false,
  setupOpen: false,
  screen: "sessions",
};

describe("decideBack", () => {
  it("closes the drawer before touching the screen behind it", () => {
    expect(decideBack({ ...base, drawerOpen: true, screen: "chat" })).toEqual({
      handled: true,
      close: "drawer",
    });
  });

  it("closes the browser, model and setup sheets in that order", () => {
    expect(decideBack({ ...base, browserOpen: true, modelOpen: true })).toEqual({
      handled: true,
      close: "browser",
    });
    expect(decideBack({ ...base, modelOpen: true, setupOpen: true })).toEqual({
      handled: true,
      close: "model",
    });
    expect(decideBack({ ...base, setupOpen: true, screen: "chat" })).toEqual({
      handled: true,
      close: "setup",
    });
  });

  it("leaves a conversation for the session list", () => {
    expect(decideBack({ ...base, screen: "chat" })).toEqual({ handled: true, screen: "sessions" });
    expect(decideBack({ ...base, screen: "settings" })).toEqual({ handled: true, screen: "sessions" });
    expect(decideBack({ ...base, screen: "terminal" })).toEqual({ handled: true, screen: "sessions" });
  });

  it("hands the gesture back to the system on the session list itself", () => {
    expect(decideBack(base)).toEqual({ handled: false });
  });
});
