// SPDX-License-Identifier: GPL-3.0-or-later
import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent } from "electron";
import * as path from "node:path";
import { CLOSE_DIALOG_CHANNELS, CLOSE_DIALOG_REASONS, parseChoice } from "./closeDialogChannels";
import type { NativeConfirmReason } from "./closeGuard";
import type { ThemeHint } from "./themeHint";

/** Not shown by then (blocked page, failed load, stalled process): the native confirm takes over so the escape hatch cannot vanish. */
export const CLOSE_DIALOG_LOAD_TIMEOUT_MS = 2000;
const CONTENT_WIDTH = 460;
const CONTENT_HEIGHT = 170;
// DESIGN.md --gh-surface per theme, so the window never flashes another colour before the page paints.
const SURFACE: Record<ThemeHint, string> = { dark: "#1a1a19", light: "#ffffff" };

export interface CloseDialogDeps {
  getParent(): BrowserWindow | null;
  /** Never asks the (possibly hung) main renderer. */
  getTheme(): ThemeHint;
  /** The OS message box used when our own window cannot be shown. Resolves true to close anyway. */
  nativeFallback(reason: NativeConfirmReason, parent: BrowserWindow | null): Promise<boolean>;
  /** Directory holding closeDialog.html and closeDialogPreload.js (dist-electron). */
  assetsDir: string;
}

export interface CloseDialog {
  /** Resolves true only when the user picked "Close anyway". Never rejects. */
  confirm(reason: NativeConfirmReason): Promise<boolean>;
  dispose(): void;
}

interface Active {
  win: BrowserWindow;
  reason: NativeConfirmReason;
  promise: Promise<boolean>;
  /** The page finished rendering its text; together with ready-to-show it may be shown. */
  onPageReady(): void;
  answer(closeAnyway: boolean): void;
}

/**
 * specs/edit-in-diff.md FR-535: the second Close press (or a hung renderer) asks through a small modal window that main
 * owns, so it works when the main renderer cannot. The main window's renderer has no IPC path to it.
 */
export function createCloseDialog(deps: CloseDialogDeps): CloseDialog {
  let active: Active | null = null;

  // Sender must be this exact window's top frame; everything else (the main window, a subframe) is refused.
  const fromActiveDialog = (event: IpcMainInvokeEvent): Active | null => {
    const a = active;
    if (!a || a.win.isDestroyed()) return null;
    const contents = a.win.webContents;
    if (event.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame) return null;
    return a;
  };

  ipcMain.handle(CLOSE_DIALOG_CHANNELS.getReason, (event) => (fromActiveDialog(event)?.reason ?? null));
  // The page has set its text and focus: only now is a first paint worth showing.
  ipcMain.handle(CLOSE_DIALOG_CHANNELS.ready, (event) => void fromActiveDialog(event)?.onPageReady());
  ipcMain.handle(CLOSE_DIALOG_CHANNELS.respond, (event, choice: unknown) => {
    const a = fromActiveDialog(event);
    const parsed = parseChoice(choice);
    if (!a || parsed === null) return;
    a.answer(parsed === "close");
  });

  const safeNative = (reason: NativeConfirmReason, parent: BrowserWindow | null): Promise<boolean> =>
    Promise.resolve()
      .then(() => deps.nativeFallback(reason, parent))
      .catch(() => false);

  function confirm(reason: NativeConfirmReason): Promise<boolean> {
    if (active) return active.promise;
    const parent = deps.getParent();
    if (!parent || parent.isDestroyed()) return safeNative(reason, null);
    if (!CLOSE_DIALOG_REASONS.includes(reason)) return safeNative(reason, parent);

    const theme = deps.getTheme();
    let win: BrowserWindow;
    try {
      win = new BrowserWindow({
        parent,
        modal: true,
        width: CONTENT_WIDTH,
        height: CONTENT_HEIGHT,
        useContentSize: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        show: false,
        title: "GitHydra",
        backgroundColor: SURFACE[theme],
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(deps.assetsDir, "closeDialogPreload.js"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          devTools: false,
          webviewTag: false,
          spellcheck: false,
          navigateOnDragDrop: false,
        },
      });
    } catch {
      return safeNative(reason, parent);
    }

    const promise = new Promise<boolean>((resolve) => {
      let settled = false;
      let shown = false;
      let readyToShow = false;
      let pageReady = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const teardown = () => {
        settled = true;
        if (timer) clearTimeout(timer);
        timer = null;
        parent.removeListener("closed", onParentClosed);
        active = null;
        if (!win.isDestroyed()) win.destroy();
      };
      const finish = (closeAnyway: boolean) => {
        if (settled) return;
        teardown();
        // Keep open hands focus back to the in-app prompt (the destroyed modal otherwise leaves it with the OS).
        if (!closeAnyway && !parent.isDestroyed()) parent.focus();
        resolve(closeAnyway);
      };
      const fallBack = () => {
        if (settled) return;
        teardown();
        void safeNative(reason, parent.isDestroyed() ? null : parent).then(resolve);
      };
      const onParentClosed = () => finish(false);
      const maybeShow = () => {
        if (settled || shown || !readyToShow || !pageReady) return;
        shown = true;
        if (timer) clearTimeout(timer);
        timer = null;
        win.show();
        win.focus();
      };

      active = {
        win,
        reason,
        promise: undefined as unknown as Promise<boolean>,
        onPageReady: () => {
          pageReady = true;
          maybeShow();
        },
        answer: finish,
      };

      parent.once("closed", onParentClosed);
      timer = setTimeout(() => {
        timer = null;
        if (!shown) fallBack();
      }, CLOSE_DIALOG_LOAD_TIMEOUT_MS);

      win.setMenu(null);
      centerOn(win, parent);
      const contents = win.webContents;
      contents.on("will-navigate", (e) => e.preventDefault());
      contents.on("will-attach-webview", (e) => e.preventDefault());
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.on("render-process-gone", fallBack);
      contents.on("unresponsive", fallBack);
      contents.on("did-fail-load", fallBack);
      win.once("ready-to-show", () => {
        readyToShow = true;
        maybeShow();
      });
      // The title-bar X, Alt+F4 or anything else that closes this window without an answer means "Keep open".
      win.once("closed", () => finish(false));
      win.loadFile(path.join(deps.assetsDir, "closeDialog.html"), { query: { theme } }).catch(fallBack);
    });
    if (active) (active as Active).promise = promise;
    return promise;
  }

  return {
    confirm,
    dispose() {
      ipcMain.removeHandler(CLOSE_DIALOG_CHANNELS.getReason);
      ipcMain.removeHandler(CLOSE_DIALOG_CHANNELS.ready);
      ipcMain.removeHandler(CLOSE_DIALOG_CHANNELS.respond);
      const a = active as Active | null;
      active = null;
      if (a && !a.win.isDestroyed()) a.win.destroy();
    },
  };
}

function centerOn(win: BrowserWindow, parent: BrowserWindow): void {
  if (parent.isMinimized()) {
    win.center();
    return;
  }
  const b = parent.getBounds();
  const [w, h] = win.getSize() as [number, number];
  const area = screen.getDisplayMatching(b).workArea;
  const x = Math.min(Math.max(Math.round(b.x + (b.width - w) / 2), area.x), area.x + Math.max(0, area.width - w));
  const y = Math.min(Math.max(Math.round(b.y + (b.height - h) / 2), area.y), area.y + Math.max(0, area.height - h));
  win.setPosition(x, y);
}
