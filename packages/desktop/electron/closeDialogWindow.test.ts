// SPDX-License-Identifier: GPL-3.0-or-later
// specs/edit-in-diff.md FR-535: the main-process close prompt. electron is mocked; the real window is covered by
// e2e-playwright/electron/closeDialogWindow.spec.ts.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  windows: [] as unknown[],
  ctorThrows: false,
  loadFileImpl: null as null | (() => Promise<void>),
}));

vi.mock("electron", async () => {
  const { EventEmitter: EE } = await import("node:events");
  class FakeWindow extends EE {
    options: Record<string, any>;
    destroyed = false;
    shown = false;
    focused = 0;
    position: [number, number] | null = null;
    centered = false;
    loaded: { file: string; opts: any } | null = null;
    menuRemoved = false;
    webContents: any;
    constructor(options: Record<string, any>) {
      super();
      if (h.ctorThrows) throw new Error("no window");
      this.options = options;
      const wc: any = new EE();
      wc.mainFrame = { id: "main-frame" };
      wc.windowOpenHandler = null;
      wc.setWindowOpenHandler = (fn: unknown) => void (wc.windowOpenHandler = fn);
      this.webContents = wc;
      h.windows.push(this);
    }
    setMenu(m: unknown) { this.menuRemoved = m === null; }
    getSize() { return [476, 219]; }
    setPosition(x: number, y: number) { this.position = [x, y]; }
    center() { this.centered = true; }
    loadFile(file: string, opts: unknown) {
      this.loaded = { file, opts };
      return h.loadFileImpl ? h.loadFileImpl() : Promise.resolve();
    }
    show() { this.shown = true; }
    focus() { this.focused += 1; }
    isDestroyed() { return this.destroyed; }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("closed");
    }
  }
  return {
    BrowserWindow: FakeWindow,
    ipcMain: {
      handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => void h.handlers.set(channel, fn),
      removeHandler: (channel: string) => void h.handlers.delete(channel),
    },
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  };
});

import { CLOSE_DIALOG_CHANNELS } from "./closeDialogChannels";
import { CLOSE_DIALOG_LOAD_TIMEOUT_MS, createCloseDialog, type CloseDialogDeps } from "./closeDialogWindow";

class FakeParent extends EventEmitter {
  destroyed = false;
  minimized = false;
  focused = 0;
  isDestroyed() { return this.destroyed; }
  isMinimized() { return this.minimized; }
  getBounds() { return { x: 100, y: 100, width: 1000, height: 700 }; }
  focus() { this.focused += 1; }
  close() { this.destroyed = true; this.emit("closed"); }
}

type W = any;
const lastWindow = (): W => h.windows[h.windows.length - 1];
const dialogEvent = (win: W, over: Record<string, unknown> = {}) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame, ...over });
const call = (channel: string, event: unknown, ...args: unknown[]) => h.handlers.get(channel)!(event, ...args);

function setup(over: Partial<CloseDialogDeps> = {}) {
  const parent = new FakeParent();
  const native = vi.fn(async (_r: string, _p: unknown) => false);
  const deps: CloseDialogDeps = {
    getParent: () => parent as never,
    getTheme: () => "dark",
    nativeFallback: native as never,
    assetsDir: "C:/app/dist-electron",
    ...over,
  };
  const dialog = createCloseDialog(deps);
  return { parent, native, dialog };
}

/** Takes the window through the page-ready handshake so it is shown. */
function showIt(win: W) {
  win.emit("ready-to-show");
  return call(CLOSE_DIALOG_CHANNELS.ready, dialogEvent(win));
}

describe("closeDialogWindow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.handlers.clear();
    h.windows.length = 0;
    h.ctorThrows = false;
    h.loadFileImpl = null;
  });
  afterEach(() => vi.useRealTimers());

  it("creates a modal child with hardened web preferences, no menu, and a background that matches the theme", () => {
    const { dialog, parent } = setup();
    void dialog.confirm("second-attempt");
    const win = lastWindow();
    expect(win.options).toMatchObject({
      parent,
      modal: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      backgroundColor: "#1a1a19",
      useContentSize: true,
      width: 460,
    });
    expect(win.options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: false,
      webviewTag: false,
    });
    expect(win.options.webPreferences.preload.replace(/\\/g, "/")).toBe("C:/app/dist-electron/closeDialogPreload.js");
    expect(win.menuRemoved).toBe(true);
    expect(win.loaded.file.replace(/\\/g, "/")).toBe("C:/app/dist-electron/closeDialog.html");
    // Parent bounds 100,100 1000x700; the window is 476x219: centred.
    expect(win.position).toEqual([362, 341]);
  });

  it("themes the window and the page from the injected source (light)", () => {
    const { dialog } = setup({ getTheme: () => "light" });
    void dialog.confirm("unresponsive");
    const win = lastWindow();
    expect(win.options.backgroundColor).toBe("#ffffff");
    expect(win.loaded.opts).toEqual({ query: { theme: "light" } });
  });

  it("centres natively when the parent is minimized", () => {
    const { dialog, parent } = setup();
    parent.minimized = true;
    void dialog.confirm("second-attempt");
    expect(lastWindow().centered).toBe(true);
  });

  it("shows only once the window is ready AND the page reported it rendered, then focuses it", () => {
    const { dialog } = setup();
    void dialog.confirm("unresponsive");
    const win = lastWindow();
    win.emit("ready-to-show");
    expect(win.shown).toBe(false);
    expect(call(CLOSE_DIALOG_CHANNELS.getReason, dialogEvent(win))).toBe("unresponsive");
    expect(win.shown).toBe(false);
    call(CLOSE_DIALOG_CHANNELS.ready, dialogEvent(win));
    expect(win.shown).toBe(true);
    expect(win.focused).toBe(1);
  });

  it("Close anyway resolves true and destroys the window", async () => {
    const { dialog } = setup();
    const p = dialog.confirm("second-attempt");
    const win = lastWindow();
    showIt(win);
    call(CLOSE_DIALOG_CHANNELS.respond, dialogEvent(win), "close");
    await expect(p).resolves.toBe(true);
    expect(win.destroyed).toBe(true);
  });

  it("Keep open resolves false, destroys the window and returns focus to the main window", async () => {
    const { dialog, parent } = setup();
    const p = dialog.confirm("second-attempt");
    const win = lastWindow();
    showIt(win);
    call(CLOSE_DIALOG_CHANNELS.respond, dialogEvent(win), "keep");
    await expect(p).resolves.toBe(false);
    expect(win.destroyed).toBe(true);
    expect(parent.focused).toBe(1);
  });

  it("closing the dialog's own title-bar X means Keep open", async () => {
    const { dialog } = setup();
    const p = dialog.confirm("second-attempt");
    const win = lastWindow();
    showIt(win);
    win.emit("closed");
    await expect(p).resolves.toBe(false);
    expect(win.destroyed).toBe(true);
  });

  it("resolves false and destroys the dialog when the main window goes away", async () => {
    const { dialog, parent } = setup();
    const p = dialog.confirm("second-attempt");
    const win = lastWindow();
    showIt(win);
    parent.close();
    await expect(p).resolves.toBe(false);
    expect(win.destroyed).toBe(true);
  });

  it("falls back to the native confirm if the window is not shown within the load timeout", async () => {
    const { dialog, native } = setup();
    native.mockResolvedValueOnce(true);
    const p = dialog.confirm("unresponsive");
    const win = lastWindow();
    await vi.advanceTimersByTimeAsync(CLOSE_DIALOG_LOAD_TIMEOUT_MS + 1);
    await expect(p).resolves.toBe(true);
    expect(native).toHaveBeenCalledWith("unresponsive", expect.anything());
    expect(win.destroyed).toBe(true);
  });

  it("does not time out once shown", async () => {
    const { dialog, native } = setup();
    const p = dialog.confirm("second-attempt");
    const win = lastWindow();
    showIt(win);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(native).not.toHaveBeenCalled();
    expect(win.destroyed).toBe(false);
    call(CLOSE_DIALOG_CHANNELS.respond, dialogEvent(win), "keep");
    await p;
  });

  it.each([
    ["loadFile rejects", () => { h.loadFileImpl = () => Promise.reject(new Error("nope")); }, null],
    ["the page fails to load", null, (w: W) => w.webContents.emit("did-fail-load")],
    ["its renderer hangs", null, (w: W) => w.webContents.emit("unresponsive")],
    ["its renderer crashes", null, (w: W) => w.webContents.emit("render-process-gone")],
  ] as const)("falls back to the native confirm when %s", async (_name, arrange, act) => {
    arrange?.();
    const { dialog, native } = setup();
    native.mockResolvedValueOnce(true);
    const p = dialog.confirm("second-attempt");
    const win = lastWindow();
    act?.(win);
    await expect(p).resolves.toBe(true);
    expect(native).toHaveBeenCalledTimes(1);
    expect(win.destroyed).toBe(true);
  });

  it("falls back to the native confirm if the window cannot even be created", async () => {
    h.ctorThrows = true;
    const { dialog, native } = setup();
    native.mockResolvedValueOnce(true);
    await expect(dialog.confirm("second-attempt")).resolves.toBe(true);
    expect(h.windows).toHaveLength(0);
  });

  it("uses the native confirm without a parent, and never rejects when that throws", async () => {
    const { dialog, native } = setup({ getParent: () => null });
    native.mockRejectedValueOnce(new Error("boom"));
    await expect(dialog.confirm("second-attempt")).resolves.toBe(false);
    expect(native).toHaveBeenCalledWith("second-attempt", null);
    expect(h.windows).toHaveLength(0);
  });

  it("refuses an unknown reason by going native (the page only knows the closed enum)", async () => {
    const { dialog, native } = setup();
    await dialog.confirm("<b>x</b>" as never);
    expect(h.windows).toHaveLength(0);
    expect(native).toHaveBeenCalledTimes(1);
  });

  it("only ever has one dialog: a second request joins the first", async () => {
    const { dialog } = setup();
    const a = dialog.confirm("second-attempt");
    const b = dialog.confirm("unresponsive");
    expect(h.windows).toHaveLength(1);
    expect(b).toBe(a);
    showIt(lastWindow());
    call(CLOSE_DIALOG_CHANNELS.respond, dialogEvent(lastWindow()), "close");
    await expect(a).resolves.toBe(true);
    void dialog.confirm("second-attempt");
    expect(h.windows).toHaveLength(2);
  });

  describe("sender validation", () => {
    it("ignores every call that does not come from this dialog's top frame", async () => {
      const { dialog } = setup();
      const p = dialog.confirm("second-attempt");
      const win = lastWindow();
      showIt(win);
      const mainRenderer = { sender: { id: "main-window-webcontents", mainFrame: {} }, senderFrame: {} };
      const subframe = dialogEvent(win, { senderFrame: { id: "iframe" } });
      const noFrame = dialogEvent(win, { senderFrame: null });
      for (const evt of [mainRenderer, subframe, noFrame, {}]) {
        expect(call(CLOSE_DIALOG_CHANNELS.getReason, evt)).toBeNull();
        call(CLOSE_DIALOG_CHANNELS.respond, evt, "close");
        call(CLOSE_DIALOG_CHANNELS.ready, evt);
      }
      expect(win.destroyed).toBe(false);
      call(CLOSE_DIALOG_CHANNELS.respond, dialogEvent(win), "keep");
      await expect(p).resolves.toBe(false);
    });

    it("ignores a request when no dialog is open, and one answered after the dialog is gone", async () => {
      const { dialog } = setup();
      expect(call(CLOSE_DIALOG_CHANNELS.getReason, { sender: {}, senderFrame: {} })).toBeNull();
      const p = dialog.confirm("second-attempt");
      const win = lastWindow();
      showIt(win);
      call(CLOSE_DIALOG_CHANNELS.respond, dialogEvent(win), "keep");
      await p;
      expect(call(CLOSE_DIALOG_CHANNELS.respond, dialogEvent(win), "close")).toBeUndefined();
    });
  });

  it.each([["CLOSE"], ["yes"], [undefined], [null], [1], [{ toString: () => "close" }], [["close"]]])(
    "ignores a respond value outside the closed enum (%s)",
    async (bad) => {
      const { dialog } = setup();
      const p = dialog.confirm("second-attempt");
      const win = lastWindow();
      showIt(win);
      call(CLOSE_DIALOG_CHANNELS.respond, dialogEvent(win), bad);
      expect(win.destroyed).toBe(false);
      call(CLOSE_DIALOG_CHANNELS.respond, dialogEvent(win), "keep");
      await p;
    },
  );

  it("denies navigation, new windows and webviews in the dialog", () => {
    const { dialog } = setup();
    void dialog.confirm("second-attempt");
    const wc = lastWindow().webContents;
    const nav = { preventDefault: vi.fn() };
    wc.emit("will-navigate", nav, "https://example.com");
    expect(nav.preventDefault).toHaveBeenCalled();
    const web = { preventDefault: vi.fn() };
    wc.emit("will-attach-webview", web);
    expect(web.preventDefault).toHaveBeenCalled();
    expect(wc.windowOpenHandler({ url: "https://example.com" })).toEqual({ action: "deny" });
  });

  it("a foreign sender's ready call never shows the window", () => {
    const { dialog } = setup();
    void dialog.confirm("second-attempt");
    const win = lastWindow();
    win.emit("ready-to-show");
    call(CLOSE_DIALOG_CHANNELS.ready, { sender: {}, senderFrame: {} });
    expect(win.shown).toBe(false);
  });

  it("dispose destroys an open dialog and unregisters both channels", () => {
    const { dialog } = setup();
    void dialog.confirm("second-attempt");
    const win = lastWindow();
    dialog.dispose();
    expect(win.destroyed).toBe(true);
    expect(h.handlers.size).toBe(0);
  });
});
