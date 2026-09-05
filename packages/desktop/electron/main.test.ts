import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// main.ts runs `app.whenReady().then(registerIpcHandlers + createWindow)` at module scope.
// Making `whenReady()` return a synchronous thenable (rather than a real Promise) means that
// callback runs synchronously during `import("./main")` below, so `ipcMain.handle` has already
// captured every handler by the time the import resolves — no timing games needed.
//
// `vi.mock(...)` factories are hoisted above local `const`/`let` declarations, so any outer
// variable they close over must itself be created via `vi.hoisted()` — otherwise it's a
// "Cannot access before initialization" error at module-eval time.
const {
  ipcHandleMock,
  fakeRepoState,
  fakeOpenBehavior,
  gitCoreWarmUpCalls,
  FakeRepoSession,
  browserWindowState,
  fakeUserDataPath,
} = vi.hoisted(() => {
  const fakeRepoState: { workdir: string | undefined } = { workdir: undefined };
  // specs/repo-open-feedback.md FR-162: records every `warmUpGitResolution(cwd)` call the real
  // `main.ts` makes, without actually spawning a real git process for every test in this file —
  // `warmUpGitResolution`'s own real behavior (cache-warming, never throwing) is covered by
  // git-core's own test suite; what's under test HERE is only "does main.ts call it, at startup,
  // without blocking window creation."
  const gitCoreWarmUpCalls: string[] = [];
  // specs/repo-open-feedback.md FR-163/FR-164/FR-165: configurable per-test so the
  // `openRepoCancellable`/`cancelOpenRepo` IPC handler tests below can simulate a real
  // `RepoSession.open()` success, failure, or `OperationCancelledError` rejection without a real
  // `Repository`/git process — main.ts's own `instanceof OperationCancelledError` branch is what's
  // under test, not RepoSession's real cancellation plumbing (covered by repoSession.test.ts).
  const fakeOpenBehavior: {
    impl: ((path: string, requestId?: string) => Promise<{ getState: () => unknown }>) | null;
    cancelOpenCalls: string[];
    // security review (specs/repo-list.md, revised IA): counts `session.dispose()` calls so the
    // `closeRepoSession` IPC handler test below can assert it actually delegates to the real
    // teardown method, not just resolves successfully without calling anything.
    disposeCalls: number;
  } = { impl: null, cancelOpenCalls: [], disposeCalls: 0 };
  class FakeRepoSession {
    getOpenRepo() {
      return { getState: () => ({ workdir: fakeRepoState.workdir }) };
    }
    async open(path: string, requestId?: string) {
      if (fakeOpenBehavior.impl) return fakeOpenBehavior.impl(path, requestId);
      return { getState: () => ({ workdir: fakeRepoState.workdir }) };
    }
    cancelOpen(requestId: string) {
      fakeOpenBehavior.cancelOpenCalls.push(requestId);
    }
    startWatch() {}
    dispose() {
      fakeOpenBehavior.disposeCalls += 1;
    }
  }
  // Layout-persistence fix (Fix 2): captures every `new BrowserWindow(...)` the mock below
  // constructs, plus lets tests fire the `resize`/`move`/`close` listeners `createWindow()`
  // registers via `.on(...)` — a real `BrowserWindow` can't be driven synchronously like this.
  const browserWindowState: { instances: FakeBrowserWindow[] } = { instances: [] };
  interface FakeBrowserWindow {
    __opts: Record<string, unknown>;
    __emit: (event: string) => void;
    on: (event: string, cb: () => void) => void;
    loadURL: (...args: unknown[]) => void;
    loadFile: (...args: unknown[]) => void;
    webContents: { setWindowOpenHandler: (...args: unknown[]) => void; send: (...args: unknown[]) => void };
    maximize: () => void;
    show: () => void;
    isMaximized: () => boolean;
    getNormalBounds: () => { x: number; y: number; width: number; height: number };
  }
  // Mutable so individual tests can point `app.getPath('userData')` at a real temp directory
  // (to exercise real fs read/write) or leave it at the default nonexistent path.
  const fakeUserDataPath = { value: "C:\\githydra-test-userdata-does-not-exist" };
  return {
    ipcHandleMock: vi.fn(),
    fakeRepoState,
    fakeOpenBehavior,
    gitCoreWarmUpCalls,
    FakeRepoSession,
    browserWindowState,
    fakeUserDataPath,
  };
});

vi.mock("electron", () => ({
  app: {
    commandLine: { appendSwitch: vi.fn() },
    isPackaged: false,
    whenReady: () => ({
      then: (cb: () => void) => {
        cb();
      },
    }),
    on: vi.fn(),
    quit: vi.fn(),
    // Layout-persistence fix: windowBounds.ts's load/save use this for its bounds JSON file. A
    // fixed, likely-nonexistent path by default — loadWindowBounds/saveWindowBounds are guarded
    // exactly like every other localStorage-pattern read/write in this app and never throw.
    // Individual tests can point this at a real temp directory via `fakeUserDataPath.value`.
    getPath: vi.fn(() => fakeUserDataPath.value),
  },
  // `main.ts` calls `new BrowserWindow(...)`, so the mock must be a real constructor — an arrow
  // function (or `mockImplementation(() => ...)`) isn't callable with `new`.
  BrowserWindow: Object.assign(
    function BrowserWindowMock(opts: Record<string, unknown>) {
      const listeners: Record<string, Array<() => void>> = {};
      const instance = {
        __opts: opts,
        __emit: (event: string) => {
          (listeners[event] ?? []).forEach((cb) => cb());
        },
        on: (event: string, cb: () => void) => {
          (listeners[event] ??= []).push(cb);
        },
        loadURL: vi.fn(),
        loadFile: vi.fn(),
        webContents: { setWindowOpenHandler: vi.fn(), send: vi.fn() },
        // Layout-persistence fix: createWindow()'s maximized-restore path and its
        // resize/move/close bounds-persist listeners touch these.
        maximize: vi.fn(),
        show: vi.fn(),
        isMaximized: () => false,
        getNormalBounds: () => ({ x: 111, y: 222, width: 1500, height: 950 }),
      };
      browserWindowState.instances.push(instance);
      return instance;
    },
    { getAllWindows: () => [] },
  ),
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: ipcHandleMock },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
  // Layout-persistence fix: createWindow() reads the current display arrangement to size/place
  // the window (first launch) and to validate a saved position is still on-screen.
  screen: {
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
    getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }),
  },
}));

// `RepoSession` normally shells out to real git via `Repository.open`. This handler only ever
// touches `session.getOpenRepo().getState()`, so a minimal fake is enough — configured per-test
// by mutating `fakeRepoState.workdir`. `main.ts` calls `new RepoSession()`, so this must be a real
// class (an arrow function isn't a valid constructor and throws "is not a constructor").
vi.mock("./repoSession", () => ({
  RepoSession: FakeRepoSession,
}));

// specs/repo-open-feedback.md FR-162: real git-core is otherwise used as-is (every error class
// main.ts imports and does `instanceof` checks against must stay the REAL class) — only
// `warmUpGitResolution` is replaced, so no test in this file spawns a real background git process
// just from importing "./main". See `gitCoreWarmUpCalls`'s own doc comment above for what's
// actually under test.
vi.mock("@githydra/git-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@githydra/git-core")>();
  return {
    ...actual,
    warmUpGitResolution: (cwd: string) => {
      gitCoreWarmUpCalls.push(cwd);
    },
  };
});

import { IPC_CHANNELS } from "../shared/ipcContract";
import { shell } from "electron";
import { loadWindowBounds, saveWindowBounds, type WindowBounds } from "./windowBounds";

function firstBrowserWindowInstance() {
  const instance = browserWindowState.instances[0];
  if (!instance) throw new Error("createWindow() never constructed a BrowserWindow");
  return instance;
}

async function getOpenPathHandler() {
  await import("./main");
  const call = ipcHandleMock.mock.calls.find(([channel]) => channel === IPC_CHANNELS.openPathInExternalEditor);
  if (!call) throw new Error("openPathInExternalEditor handler was never registered");
  return call[1] as (evt: unknown, filePath: string) => Promise<{ ok: boolean; error?: { name: string } }>;
}

// specs/repo-open-feedback.md FR-163/FR-164/FR-165
async function getOpenRepoCancellableHandler() {
  await import("./main");
  const call = ipcHandleMock.mock.calls.find(([channel]) => channel === IPC_CHANNELS.openRepoCancellable);
  if (!call) throw new Error("openRepoCancellable handler was never registered");
  return call[1] as (
    evt: unknown,
    repoPath: string,
    requestId: string,
  ) => Promise<{ outcome: "settled"; result: { ok: boolean; error?: { name: string } } } | { outcome: "cancelled" }>;
}

async function getCancelOpenRepoHandler() {
  await import("./main");
  const call = ipcHandleMock.mock.calls.find(([channel]) => channel === IPC_CHANNELS.cancelOpenRepo);
  if (!call) throw new Error("cancelOpenRepo handler was never registered");
  return call[1] as (evt: unknown, requestId: string) => unknown;
}

// security review (specs/repo-list.md, revised IA): the fix for "+ New tab"/closing the last tab
// not actually tearing down the main-process watcher.
async function getCloseRepoSessionHandler() {
  await import("./main");
  const call = ipcHandleMock.mock.calls.find(([channel]) => channel === IPC_CHANNELS.closeRepoSession);
  if (!call) throw new Error("closeRepoSession handler was never registered");
  return call[1] as (evt: unknown) => Promise<{ ok: boolean }>;
}

describe("openPathInExternalEditor IPC handler — symlink escape refusal", () => {
  let tmpRoot: string;
  let workdir: string;
  let outsideDir: string;

  beforeEach(async () => {
    vi.resetModules();
    ipcHandleMock.mockClear();
    vi.mocked(shell.openPath).mockClear();

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-openpath-"));
    workdir = path.join(tmpRoot, "repo");
    outsideDir = path.join(tmpRoot, "outside");
    await fs.mkdir(workdir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    fakeRepoState.workdir = workdir;
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("opens an ordinary conflicted file normally (control case: shell.openPath IS called)", async () => {
    await fs.writeFile(path.join(workdir, "conflicted.txt"), "content");
    vi.mocked(shell.openPath).mockResolvedValue("");

    const handler = await getOpenPathHandler();
    const result = await handler(undefined, "conflicted.txt");

    expect(shell.openPath).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("refuses a conflicted file whose working-tree entry is a symlink pointing outside the repo, and never calls shell.openPath", async () => {
    // Attempt symlink creation, but skip gracefully — Windows can require elevated privileges
    // (SeCreateSymbolicLinkPrivilege / Developer Mode) for `fs.symlink` to succeed.
    const outsideTarget = path.join(outsideDir, "payload.exe");
    await fs.writeFile(outsideTarget, "not a real exe, just a probe target");
    const conflictedPath = path.join(workdir, "conflicted-file.exe");
    try {
      await fs.symlink(outsideTarget, conflictedPath, "file");
    } catch {
      // eslint-disable-next-line no-console
      console.warn("Skipping symlink-escape test: fs.symlink not permitted in this environment.");
      return;
    }

    const handler = await getOpenPathHandler();
    const result = await handler(undefined, "conflicted-file.exe");

    expect(shell.openPath).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error?.name).toBe("InvalidArgumentError");
  });
});

// specs/repo-open-feedback.md FR-163/FR-164/FR-165: the `openRepoCancellable`/`cancelOpenRepo` IPC
// handlers. `RepoSession.open()`'s real cancellation plumbing is covered by repoSession.test.ts
// (against a mocked `Repository.open`) and by packages/git-core's own suite (against a real git
// process, proving no orphaned process on cancel) — this describe block instead verifies main.ts's
// own OWN piece: that a `RepoSession.open()` rejection of `OperationCancelledError` is translated
// to the distinct `{ outcome: "cancelled" }` result (never `{ outcome: "settled", result: {ok:
// false, ...} }`), while a genuine success/failure still surfaces via the ordinary "settled" shape.
describe("openRepoCancellable / cancelOpenRepo IPC handlers", () => {
  beforeEach(() => {
    vi.resetModules();
    ipcHandleMock.mockClear();
    fakeOpenBehavior.impl = null;
    fakeOpenBehavior.cancelOpenCalls = [];
  });

  it("resolves { outcome: 'settled', result: { ok: true, ... } } on a normal successful open", async () => {
    fakeOpenBehavior.impl = async (repoPath: string) => ({ getState: () => ({ workdir: repoPath }) });

    const handler = await getOpenRepoCancellableHandler();
    const outcome = await handler(undefined, "/repo", "req-1");

    expect(outcome.outcome).toBe("settled");
    if (outcome.outcome === "settled") {
      expect(outcome.result.ok).toBe(true);
    }
  });

  it("resolves { outcome: 'settled', result: { ok: false, ... } } on a genuine git-core error — never mistaken for a cancellation", async () => {
    fakeOpenBehavior.impl = async () => {
      throw new Error("not a git repository");
    };

    const handler = await getOpenRepoCancellableHandler();
    const outcome = await handler(undefined, "/not-a-repo", "req-1");

    expect(outcome.outcome).toBe("settled");
    if (outcome.outcome === "settled") {
      expect(outcome.result.ok).toBe(false);
    }
  });

  it("resolves { outcome: 'cancelled' } — never a rejected promise, never {ok:false} — when RepoSession.open() throws OperationCancelledError", async () => {
    const { OperationCancelledError } = await import("@githydra/git-core");
    fakeOpenBehavior.impl = async () => {
      throw new OperationCancelledError(["status"]);
    };

    const handler = await getOpenRepoCancellableHandler();
    const outcome = await handler(undefined, "/repo", "req-1");

    expect(outcome).toEqual({ outcome: "cancelled" });
  });

  it("cancelOpenRepo(requestId) forwards to session.cancelOpen(requestId)", async () => {
    const cancelHandler = await getCancelOpenRepoHandler();
    await cancelHandler(undefined, "req-42");

    expect(fakeOpenBehavior.cancelOpenCalls).toEqual(["req-42"]);
  });
});

// security review (specs/repo-list.md, revised IA): "+ New tab" (and closing the last tab) called
// `graph.closeRepo()`, which only closed the renderer's own commit-log readers — there was no IPC
// channel telling the main-process `RepoSession` to close its ref-change watcher/clear the live
// repo, so that watcher stayed alive (firing into the main process) for as long as the app sat on
// the idle landing screen afterward. This proves the new `closeRepoSession` channel exists and
// delegates to the real `session.dispose()` teardown (unit-tested directly in
// `repoSession.test.ts`) rather than being a no-op stub.
describe("closeRepoSession IPC handler (security review fix)", () => {
  beforeEach(() => {
    vi.resetModules();
    ipcHandleMock.mockClear();
    fakeOpenBehavior.disposeCalls = 0;
  });

  it("delegates to session.dispose(), resolving { ok: true }", async () => {
    const handler = await getCloseRepoSessionHandler();
    const result = await handler(undefined);

    expect(fakeOpenBehavior.disposeCalls).toBe(1);
    expect(result.ok).toBe(true);
  });
});

// specs/repo-open-feedback.md FR-162
describe("app-startup git-resolution warm-up (FR-162)", () => {
  beforeEach(() => {
    vi.resetModules();
    ipcHandleMock.mockClear();
    gitCoreWarmUpCalls.length = 0;
    browserWindowState.instances.length = 0;
  });

  it("calls warmUpGitResolution(os.tmpdir()) once at startup", async () => {
    await import("./main");
    expect(gitCoreWarmUpCalls).toEqual([os.tmpdir()]);
  });

  it("never blocks window creation — createWindow() still runs regardless of warm-up (fire-and-forget, not awaited)", async () => {
    await import("./main");
    // If the warm-up call were mistakenly awaited before createWindow(), a slow/hanging
    // implementation would prevent this from ever being populated within the same tick this
    // synchronous `whenReady().then()` callback runs in (see this file's own top-of-file doc
    // comment on `whenReady()`'s synchronous-thenable mock).
    expect(browserWindowState.instances).toHaveLength(1);
  });
});

// Fix 2 (layout-persistence, confirmed directly with the user): createWindow()'s own use of
// windowBounds.ts — restoring saved bounds, falling back to a display-relative default, and
// persisting on resize/move (debounced) and close (immediate).
describe("createWindow() — window bounds persistence (Fix 2)", () => {
  let tmpUserData: string;

  beforeEach(async () => {
    vi.resetModules();
    browserWindowState.instances.length = 0;
    tmpUserData = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-windowbounds-main-"));
    fakeUserDataPath.value = tmpUserData;
  });

  afterEach(async () => {
    fakeUserDataPath.value = "C:\\githydra-test-userdata-does-not-exist";
    await fs.rm(tmpUserData, { recursive: true, force: true });
  });

  it("opens at a display-relative default (not a hardcoded 1400x900) when nothing is saved yet", async () => {
    await import("./main");
    expect(browserWindowState.instances).toHaveLength(1);
    const opts = firstBrowserWindowInstance().__opts;
    // screen mock above reports a 1920x1080 primary work area — the default should be sized
    // relative to that (~85-90%), not the old hardcoded 1400.
    expect(opts.width).not.toBe(1400);
    expect(opts.width).toBeGreaterThan(1920 * 0.8);
    expect(opts.height).toBeGreaterThan(1080 * 0.8);
    expect(opts.show).not.toBe(false);
  });

  it("restores a previously-saved position/size on the next launch", async () => {
    const saved: WindowBounds = { x: 44, y: 55, width: 1234, height: 876, isMaximized: false };
    saveWindowBounds(tmpUserData, saved);

    await import("./main");

    const opts = firstBrowserWindowInstance().__opts;
    expect(opts).toMatchObject({ x: 44, y: 55, width: 1234, height: 876 });
  });

  it("falls back to the display-relative default when the saved position is now off-screen", async () => {
    // Far outside the mocked screen's single 1920x1080 display.
    const offscreen: WindowBounds = { x: 9000, y: 9000, width: 1400, height: 900, isMaximized: false };
    saveWindowBounds(tmpUserData, offscreen);

    await import("./main");

    const opts = firstBrowserWindowInstance().__opts;
    expect(opts.x).not.toBe(9000);
    expect(opts.width).not.toBe(1400);
  });

  it("restores a saved maximized window by creating it hidden, then maximizing and showing it (no flash)", async () => {
    const saved: WindowBounds = { x: 0, y: 0, width: 1920, height: 1080, isMaximized: true };
    saveWindowBounds(tmpUserData, saved);

    await import("./main");

    const instance = firstBrowserWindowInstance();
    expect(instance.__opts.show).toBe(false);
    expect(instance.maximize).toHaveBeenCalledTimes(1);
    expect(instance.show).toHaveBeenCalledTimes(1);
  });

  it("persists bounds to disk (debounced) once the debounce window elapses after a resize event", async () => {
    vi.useFakeTimers();
    try {
      await import("./main");
      const instance = firstBrowserWindowInstance();

      instance.__emit("resize");
      instance.__emit("resize");
      instance.__emit("resize");
      // Not yet written — coalesced, not one write per event.
      expect(loadWindowBounds(tmpUserData)).toBeNull();

      vi.advanceTimersByTime(600);

      const persisted = loadWindowBounds(tmpUserData);
      expect(persisted).toEqual({ x: 111, y: 222, width: 1500, height: 950, isMaximized: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists bounds to disk (debounced) after a move event", async () => {
    vi.useFakeTimers();
    try {
      await import("./main");
      const instance = firstBrowserWindowInstance();

      instance.__emit("move");
      vi.advanceTimersByTime(600);

      expect(loadWindowBounds(tmpUserData)).toEqual({ x: 111, y: 222, width: 1500, height: 950, isMaximized: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists bounds to disk immediately (not debounced) on close, so a gesture right before quitting isn't lost", async () => {
    await import("./main");
    const instance = firstBrowserWindowInstance();

    instance.__emit("close");

    // No `vi.advanceTimersByTime` needed — close's own listener calls persistBounds directly.
    expect(loadWindowBounds(tmpUserData)).toEqual({ x: 111, y: 222, width: 1500, height: 950, isMaximized: false });
  });

  it("passes a window icon pointing at the dev build/icons output when unpackaged (app.isPackaged is mocked false)", async () => {
    await import("./main");
    const opts = firstBrowserWindowInstance().__opts;
    // Regression guard for the app-icon integration: on Linux, BrowserWindow's own `icon`
    // option is the only source of the running window's taskbar icon (Windows/macOS instead
    // get theirs from the packaged exe/.app bundle — see electron-builder.yml). Unpackaged
    // (dev) runs must resolve to the generated build/icons/512x512.png next to electron/,
    // never a process.resourcesPath path that only exists once packaged.
    expect(typeof opts.icon).toBe("string");
    const icon = opts.icon as string;
    expect(icon.replace(/\\/g, "/")).toMatch(/build\/icons\/512x512\.png$/);
    expect(icon).not.toContain("resources");
  });
});
