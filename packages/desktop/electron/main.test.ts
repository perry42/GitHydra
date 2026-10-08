// SPDX-License-Identifier: GPL-3.0-or-later
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
  fakeFetchBehavior,
  fakePullBehavior,
  gitCoreWarmUpCalls,
  FakeRepoSession,
  browserWindowState,
  fakeUserDataPath,
  partialStagingCalls,
  partialStagingBehavior,
  fakeEdit,
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
  // specs/online-sync-fetch.md FR-322/FR-327: configurable per-test so the `fetchAllRemotes`/
  // `cancelFetch` IPC handler tests below can simulate a real `Repository.fetchAllRemotes()`
  // success, failure, or `OperationCancelledError` rejection without a real `Repository`/git
  // process — main.ts's own `instanceof OperationCancelledError` branch and progress-forwarding
  // are what's under test here, not git-core's real fetch plumbing (covered by its own suite).
  const fakeFetchBehavior: {
    impl: ((options: { signal?: AbortSignal; onProgress?: (event: unknown) => void }) => Promise<unknown>) | null;
    registerFetchCalls: string[];
    clearFetchCalls: string[];
    cancelFetchCalls: string[];
  } = { impl: null, registerFetchCalls: [], clearFetchCalls: [], cancelFetchCalls: [] };
  // specs/online-sync-pull.md FR-338/FR-339/FR-343: same configurable-per-test convention as
  // `fakeFetchBehavior` above, for the `pull`/`cancelPull` IPC handler tests — main.ts's own
  // `pull` handler deliberately reuses `registerFetch`/`clearFetch`/`cancelFetch` (see its own doc
  // comment), so this fake's `pull()` accepts the exact same `{ signal, onProgress }` shape and its
  // register/clear/cancel bookkeeping is `fakeFetchBehavior`'s own arrays, not a separate set.
  const fakePullBehavior: {
    impl:
      | ((options: { strategy?: string; signal?: AbortSignal; onProgress?: (event: unknown) => void }) => Promise<unknown>)
      | null;
  } = { impl: null };
  // specs/hunk-line-staging.md FR-453: records what reaches git-core, and lets a test make it throw.
  const partialStagingCalls: { method: string; args: unknown[] }[] = [];
  const partialStagingBehavior: { error: Error | null } = { error: null };
  const recordPartial = (method: string) => async (...args: unknown[]) => {
    partialStagingCalls.push({ method, args });
    if (partialStagingBehavior.error) throw partialStagingBehavior.error;
  };
  // specs/edit-in-diff.md FR-536: lets a test fire the work-tree callback `main.ts` hands to `startWatch`.
  const fakeEdit: {
    writeResult: unknown;
    worktreeCallback: ((change?: { paths: string[]; truncated: boolean }) => void) | null;
  } = { writeResult: { status: "written", contentHash: "b".repeat(64), mtimeMs: 1, size: 1 }, worktreeCallback: null };
  class FakeRepoSession {
    getOpenRepo() {
      return {
        getState: () => ({ workdir: fakeRepoState.workdir }),
        probeEditableFile: recordPartial("probeEditableFile"),
        readEditableFile: recordPartial("readEditableFile"),
        writeEditedFile: async (...args: unknown[]) => {
          partialStagingCalls.push({ method: "writeEditedFile", args });
          return fakeEdit.writeResult;
        },
        getCombinedFileDiff: recordPartial("getCombinedFileDiff"),
        toggleCombinedLines: recordPartial("toggleCombinedLines"),
        discardCombinedLines: recordPartial("discardCombinedLines"),
        getDiscardFingerprint: recordPartial("getDiscardFingerprint"),
        discardTrackedFileChanges: recordPartial("discardTrackedFileChanges"),
        discardUntrackedFile: recordPartial("discardUntrackedFile"),
        // specs/ignore-and-multiselect.md: recorded like the partial-staging calls; main must hand git-core rebuilt, validated arguments.
        planIgnore: recordPartial("planIgnore"),
        ignorePaths: recordPartial("ignorePaths"),
        ignoreAndStopTracking: recordPartial("ignoreAndStopTracking"),
        getDiscardPreview: recordPartial("getDiscardPreview"),
        stagePaths: recordPartial("stagePaths"),
        unstagePaths: recordPartial("unstagePaths"),
        getBulkDiscardFingerprints: recordPartial("getBulkDiscardFingerprints"),
        bulkDiscard: recordPartial("bulkDiscard"),
        planDiscardAll: recordPartial("planDiscardAll"),
        discardAllChanges: recordPartial("discardAllChanges"),
        fetchAllRemotes: (options: { signal?: AbortSignal; onProgress?: (event: unknown) => void }) => {
          if (fakeFetchBehavior.impl) return fakeFetchBehavior.impl(options);
          return Promise.resolve({ outcomes: [] });
        },
        pull: (options: { strategy?: string; signal?: AbortSignal; onProgress?: (event: unknown) => void }) => {
          if (fakePullBehavior.impl) return fakePullBehavior.impl(options);
          return Promise.resolve({ kind: "up-to-date" });
        },
      };
    }
    registerFetch(requestId: string) {
      fakeFetchBehavior.registerFetchCalls.push(requestId);
      return new AbortController().signal;
    }
    clearFetch(requestId: string) {
      fakeFetchBehavior.clearFetchCalls.push(requestId);
    }
    cancelFetch(requestId: string) {
      fakeFetchBehavior.cancelFetchCalls.push(requestId);
    }
    // specs/repo-open-feedback-fixes.md FR-197/FR-199: this hand-rolled fake models neither the
    // real pending/committed distinction nor per-requestId reader tracking — main.test.ts only
    // exercises `openRepoCancellable`'s own `instanceof OperationCancelledError` branch (covered
    // by `repoSession.test.ts`/`useRepositoryGraph`'s own suites against the real class), so these
    // stubs just need to exist and not throw.
    async open(path: string, requestId?: string) {
      if (fakeOpenBehavior.impl) return fakeOpenBehavior.impl(path, requestId);
      return { getState: () => ({ workdir: fakeRepoState.workdir }) };
    }
    getOpenRepoFor() {
      return this.getOpenRepo();
    }
    getOpenSignal() {
      return undefined;
    }
    commitOpen() {
      return true;
    }
    endOpenAttempt() {}
    createReader() {
      return "reader-1";
    }
    cancelOpen(requestId: string) {
      fakeOpenBehavior.cancelOpenCalls.push(requestId);
    }
    startWatch(_onRefs: unknown, onWorktree?: (change?: { paths: string[]; truncated: boolean }) => void) {
      fakeEdit.worktreeCallback = onWorktree ?? null;
    }
    refreshWorktreeIgnoreList() {
      partialStagingCalls.push({ method: "refreshWorktreeIgnoreList", args: [] });
    }
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
    __emit: (event: string, ...args: unknown[]) => void;
    on: (event: string, cb: (...args: unknown[]) => void) => void;
    close: () => void;
    loadURL: (...args: unknown[]) => void;
    loadFile: (...args: unknown[]) => void;
    webContents: {
      setWindowOpenHandler: (...args: unknown[]) => void;
      send: (...args: unknown[]) => void;
      // security-reviewer finding (repoSession leak on renderer reload/crash): lets tests fire the
      // `render-process-gone`/`did-start-navigation` listeners `createWindow()` registers on
      // `webContents`, exactly like `__emit` above does for the `BrowserWindow` itself — a real
      // `webContents` can't be driven synchronously like this.
      on: (event: string, cb: (...args: unknown[]) => void) => void;
      __emit: (event: string, ...args: unknown[]) => void;
    };
    maximize: () => void;
    show: () => void;
    focus: () => void;
    restore: () => void;
    isMinimized: () => boolean;
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
    fakeFetchBehavior,
    fakePullBehavior,
    gitCoreWarmUpCalls,
    FakeRepoSession,
    browserWindowState,
    fakeUserDataPath,
    partialStagingCalls,
    partialStagingBehavior,
    fakeEdit,
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
      const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
      // security-reviewer finding (repoSession leak on renderer reload/crash): a separate listener
      // map for `webContents` events, mirroring `listeners`/`__emit` above but for
      // `render-process-gone`/`did-start-navigation`, which main.ts registers on `webContents`,
      // not the `BrowserWindow` itself.
      const webContentsListeners: Record<string, Array<(...args: unknown[]) => void>> = {};
      const instance = {
        __opts: opts,
        __emit: (event: string, ...args: unknown[]) => {
          (listeners[event] ?? []).forEach((cb) => cb(...args));
        },
        on: (event: string, cb: (...args: unknown[]) => void) => {
          (listeners[event] ??= []).push(cb);
        },
        close: vi.fn(),
        loadURL: vi.fn(),
        loadFile: vi.fn(),
        webContents: {
          setWindowOpenHandler: vi.fn(),
          send: vi.fn(),
          on: (event: string, cb: (...args: unknown[]) => void) => {
            (webContentsListeners[event] ??= []).push(cb);
          },
          __emit: (event: string, ...args: unknown[]) => {
            (webContentsListeners[event] ?? []).forEach((cb) => cb(...args));
          },
        },
        // Layout-persistence fix: createWindow()'s maximized-restore path and its
        // resize/move/close bounds-persist listeners touch these.
        maximize: vi.fn(),
        show: vi.fn(),
        focus: vi.fn(),
        restore: vi.fn(),
        isMinimized: () => false,
        isMaximized: () => false,
        getNormalBounds: () => ({ x: 111, y: 222, width: 1500, height: 950 }),
      };
      browserWindowState.instances.push(instance);
      return instance;
    },
    { getAllWindows: () => [] },
  ),
  powerMonitor: { on: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn(async () => ({ response: 1 })) },
  ipcMain: { handle: ipcHandleMock },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
  // specs/keyboard-shortcuts-command-palette.md FR-226/AC7 support fix: `buildApplicationMenu`
  // calls both of these once, in `app.whenReady()`, before `createWindow()`.
  Menu: {
    setApplicationMenu: vi.fn(),
    buildFromTemplate: vi.fn(() => ({})),
  },
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
import { app, dialog, shell } from "electron";
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

// specs/online-sync-fetch.md FR-320 through FR-328
async function getFetchAllRemotesHandler() {
  await import("./main");
  const call = ipcHandleMock.mock.calls.find(([channel]) => channel === IPC_CHANNELS.fetchAllRemotes);
  if (!call) throw new Error("fetchAllRemotes handler was never registered");
  return call[1] as (
    evt: unknown,
    requestId: string,
  ) => Promise<{ outcome: "settled"; result: { ok: boolean; data?: unknown; error?: { name: string } } } | { outcome: "cancelled" }>;
}

async function getCancelFetchHandler() {
  await import("./main");
  const call = ipcHandleMock.mock.calls.find(([channel]) => channel === IPC_CHANNELS.cancelFetch);
  if (!call) throw new Error("cancelFetch handler was never registered");
  return call[1] as (evt: unknown, requestId: string) => unknown;
}

// specs/online-sync-pull.md FR-338 through FR-343
async function getPullHandler() {
  await import("./main");
  const call = ipcHandleMock.mock.calls.find(([channel]) => channel === IPC_CHANNELS.pull);
  if (!call) throw new Error("pull handler was never registered");
  return call[1] as (
    evt: unknown,
    requestId: string,
    options?: { strategy?: string },
  ) => Promise<{ outcome: "settled"; result: { ok: boolean; data?: unknown; error?: { name: string } } } | { outcome: "cancelled" }>;
}

async function getCancelPullHandler() {
  await import("./main");
  const call = ipcHandleMock.mock.calls.find(([channel]) => channel === IPC_CHANNELS.cancelPull);
  if (!call) throw new Error("cancelPull handler was never registered");
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

// security-reviewer finding (specs/repo-open-feedback-fixes.md follow-up): a renderer reload or
// crash mid-open never fires BrowserWindow's "closed" event, so `useRepositoryGraph.ts`'s own
// `finally`-block cleanup (`endOpenAttempt`) never runs and `RepoSession`'s per-requestId
// bookkeeping (including a live `CommitLogReader` child process) leaks indefinitely. This proves
// `createWindow()` wires both `webContents.on("render-process-gone", ...)` and
// `webContents.on("did-start-navigation", ...)` to the same `session.dispose()` teardown
// `"closed"`/`"window-all-closed"` already use — a genuine Electron reload/crash can't be
// simulated in this mocked-`electron` test setup, so (per this file's own `FakeRepoSession`
// convention above) this instead verifies the handlers are actually registered and call the right
// cleanup method when invoked directly, exactly like `closeRepoSession`'s test above does for the
// IPC-triggered path.
describe("renderer reload/crash mid-open — RepoSession cleanup (security review fix)", () => {
  beforeEach(() => {
    vi.resetModules();
    browserWindowState.instances.length = 0;
    fakeOpenBehavior.disposeCalls = 0;
  });

  it("calls session.dispose() when webContents emits render-process-gone (renderer crashed/killed/oom)", async () => {
    await import("./main");
    const instance = firstBrowserWindowInstance();

    instance.webContents.__emit("render-process-gone", undefined, { reason: "crashed", exitCode: 1 });

    expect(fakeOpenBehavior.disposeCalls).toBe(1);
  });

  it("calls session.dispose() on a real reload (isMainFrame: true, isInPlace: false)", async () => {
    await import("./main");
    const instance = firstBrowserWindowInstance();
    // The initial loadURL/loadFile call above already happened before this listener was
    // registered in this synchronous mock, so this __emit models the NEXT navigation — a Ctrl+R
    // reload — not the app's own initial page load.
    instance.webContents.__emit("did-start-navigation", undefined, "file:///index.html", false, true);

    expect(fakeOpenBehavior.disposeCalls).toBe(1);
  });

  it("does NOT call session.dispose() for an in-page navigation (hash change / pushState)", async () => {
    await import("./main");
    const instance = firstBrowserWindowInstance();

    instance.webContents.__emit("did-start-navigation", undefined, "file:///index.html#section", true, true);

    expect(fakeOpenBehavior.disposeCalls).toBe(0);
  });

  it("does NOT call session.dispose() for a sub-frame navigation (e.g. an iframe)", async () => {
    await import("./main");
    const instance = firstBrowserWindowInstance();

    instance.webContents.__emit("did-start-navigation", undefined, "file:///frame.html", false, false);

    expect(fakeOpenBehavior.disposeCalls).toBe(0);
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

// specs/online-sync-fetch.md FR-320 through FR-328: the `fetchAllRemotes`/`cancelFetch` IPC
// handlers — the first network-capable IPC surface this app has ever exposed. Mirrors the
// `openRepoCancellable`/`cancelOpenRepo` describe block's own scoping note: git-core's real
// `fetchAllRemotes()`/cancellation plumbing is covered by its own suite; what's under test here is
// main.ts's own translation of a real `OperationCancelledError` into the distinct `{ outcome:
// "cancelled" }` result, `registerFetch`/`clearFetch` lifecycle discipline, and progress forwarding.
describe("fetchAllRemotes / cancelFetch IPC handlers (FR-320 through FR-328)", () => {
  beforeEach(() => {
    vi.resetModules();
    ipcHandleMock.mockClear();
    fakeFetchBehavior.impl = null;
    fakeFetchBehavior.registerFetchCalls = [];
    fakeFetchBehavior.clearFetchCalls = [];
    fakeFetchBehavior.cancelFetchCalls = [];
    browserWindowState.instances.length = 0;
  });

  it("resolves { outcome: 'settled', result: { ok: true, data } } on a normal successful fetch, and registers+clears the requestId", async () => {
    fakeFetchBehavior.impl = async () => ({ outcomes: [{ remoteName: "origin", status: "ok" }] });

    const handler = await getFetchAllRemotesHandler();
    const outcome = await handler(undefined, "req-1");

    expect(outcome.outcome).toBe("settled");
    if (outcome.outcome === "settled") {
      expect(outcome.result.ok).toBe(true);
      expect(outcome.result.data).toEqual({ outcomes: [{ remoteName: "origin", status: "ok" }] });
    }
    expect(fakeFetchBehavior.registerFetchCalls).toEqual(["req-1"]);
    expect(fakeFetchBehavior.clearFetchCalls).toEqual(["req-1"]);
  });

  it("resolves { outcome: 'settled', result: { ok: false, ... } } on a genuine top-level failure — never mistaken for a cancellation", async () => {
    fakeFetchBehavior.impl = async () => {
      throw new Error("No repository is open");
    };

    const handler = await getFetchAllRemotesHandler();
    const outcome = await handler(undefined, "req-1");

    expect(outcome.outcome).toBe("settled");
    if (outcome.outcome === "settled") {
      expect(outcome.result.ok).toBe(false);
    }
    // Still cleared even on a genuine failure — no leaked bookkeeping.
    expect(fakeFetchBehavior.clearFetchCalls).toEqual(["req-1"]);
  });

  it("resolves { outcome: 'cancelled' } — never a rejected promise, never {ok:false} — when fetchAllRemotes() throws OperationCancelledError", async () => {
    const { OperationCancelledError } = await import("@githydra/git-core");
    fakeFetchBehavior.impl = async () => {
      throw new OperationCancelledError(["fetch"]);
    };

    const handler = await getFetchAllRemotesHandler();
    const outcome = await handler(undefined, "req-1");

    expect(outcome).toEqual({ outcome: "cancelled" });
    expect(fakeFetchBehavior.clearFetchCalls).toEqual(["req-1"]);
  });

  it("forwards each onProgress event to the renderer via webContents.send, tagged with the requestId", async () => {
    fakeFetchBehavior.impl = async (options) => {
      options.onProgress?.({ remoteName: "origin", stage: "Counting objects", percent: 50, raw: "raw" });
      return { outcomes: [] };
    };

    const handler = await getFetchAllRemotesHandler();
    await handler(undefined, "req-1");

    const instance = firstBrowserWindowInstance();
    expect(instance.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.fetchProgressEvent,
      "req-1",
      { remoteName: "origin", stage: "Counting objects", percent: 50, raw: "raw" },
    );
  });

  it("cancelFetch(requestId) forwards to session.cancelFetch(requestId)", async () => {
    const handler = await getCancelFetchHandler();
    await handler(undefined, "req-42");

    expect(fakeFetchBehavior.cancelFetchCalls).toEqual(["req-42"]);
  });
});

// specs/online-sync-pull.md FR-338 through FR-343: the `pull`/`cancelPull` IPC handlers. Same
// scoping note as the `fetchAllRemotes`/`cancelFetch` block above: git-core's real `pull()` (and
// what it does internally to reach a fast-forward/merge/rebase/conflict) is covered by its own
// suite; what's under test here is main.ts's own translation of a real `OperationCancelledError`
// into the distinct `{ outcome: "cancelled" }` result, that a genuine conflict/refusal serializes
// as an ordinary `{ ok: false, ... }` (never specially detected/rewritten here — FR-338's "zero new
// conflict-handling code" guarantee), the shared `registerFetch`/`clearFetch`/`cancelFetch`
// bookkeeping discipline, the `strategy` option being threaded straight through, and progress
// forwarding on the dedicated `pullProgressEvent` channel.
describe("pull / cancelPull IPC handlers (FR-338 through FR-343)", () => {
  beforeEach(() => {
    vi.resetModules();
    ipcHandleMock.mockClear();
    fakePullBehavior.impl = null;
    fakeFetchBehavior.registerFetchCalls = [];
    fakeFetchBehavior.clearFetchCalls = [];
    fakeFetchBehavior.cancelFetchCalls = [];
    browserWindowState.instances.length = 0;
  });

  it("resolves { outcome: 'settled', result: { ok: true, data } } on a normal successful pull, and registers+clears the requestId", async () => {
    fakePullBehavior.impl = async () => ({ kind: "fast-forward", fromSha: "a".repeat(40), toSha: "b".repeat(40) });

    const handler = await getPullHandler();
    const outcome = await handler(undefined, "req-1");

    expect(outcome.outcome).toBe("settled");
    if (outcome.outcome === "settled") {
      expect(outcome.result.ok).toBe(true);
      expect(outcome.result.data).toEqual({ kind: "fast-forward", fromSha: "a".repeat(40), toSha: "b".repeat(40) });
    }
    expect(fakeFetchBehavior.registerFetchCalls).toEqual(["req-1"]);
    expect(fakeFetchBehavior.clearFetchCalls).toEqual(["req-1"]);
  });

  it("threads options.strategy straight through to Repository.pull()", async () => {
    let received: string | undefined;
    fakePullBehavior.impl = async (options) => {
      received = options.strategy;
      return { kind: "integrated", strategy: options.strategy };
    };

    const handler = await getPullHandler();
    await handler(undefined, "req-1", { strategy: "rebase" });

    expect(received).toBe("rebase");
  });

  it("resolves { outcome: 'settled', result: { ok: false, ... } } on a genuine refusal (e.g. NoUpstreamConfiguredError) — never mistaken for a cancellation", async () => {
    fakePullBehavior.impl = async () => {
      throw new Error("No upstream configured for the current branch");
    };

    const handler = await getPullHandler();
    const outcome = await handler(undefined, "req-1");

    expect(outcome.outcome).toBe("settled");
    if (outcome.outcome === "settled") {
      expect(outcome.result.ok).toBe(false);
    }
    expect(fakeFetchBehavior.clearFetchCalls).toEqual(["req-1"]);
  });

  it("resolves { outcome: 'settled', result: { ok: false, ... } } for a paused merge/rebase conflict too — surfaced as an ordinary failure, never specially detected here (FR-338)", async () => {
    fakePullBehavior.impl = async () => {
      throw new Error("Automatic merge failed; fix conflicts and then commit the result.");
    };

    const handler = await getPullHandler();
    const outcome = await handler(undefined, "req-1");

    expect(outcome.outcome).toBe("settled");
    if (outcome.outcome === "settled") {
      expect(outcome.result.ok).toBe(false);
    }
  });

  it("resolves { outcome: 'cancelled' } — never a rejected promise, never {ok:false} — when pull() throws OperationCancelledError", async () => {
    const { OperationCancelledError } = await import("@githydra/git-core");
    fakePullBehavior.impl = async () => {
      throw new OperationCancelledError(["fetch"]);
    };

    const handler = await getPullHandler();
    const outcome = await handler(undefined, "req-1");

    expect(outcome).toEqual({ outcome: "cancelled" });
    expect(fakeFetchBehavior.clearFetchCalls).toEqual(["req-1"]);
  });

  it("forwards each onProgress event to the renderer via webContents.send, on the pullProgressEvent channel, tagged with the requestId", async () => {
    fakePullBehavior.impl = async (options) => {
      options.onProgress?.({ remoteName: "origin", stage: "Counting objects", percent: 50, raw: "raw" });
      return { kind: "up-to-date" };
    };

    const handler = await getPullHandler();
    await handler(undefined, "req-1");

    const instance = firstBrowserWindowInstance();
    expect(instance.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.pullProgressEvent,
      "req-1",
      { remoteName: "origin", stage: "Counting objects", percent: 50, raw: "raw" },
    );
  });

  it("cancelPull(requestId) forwards to session.cancelFetch(requestId) — the shared bookkeeping pull reuses", async () => {
    const handler = await getCancelPullHandler();
    await handler(undefined, "req-42");

    expect(fakeFetchBehavior.cancelFetchCalls).toEqual(["req-42"]);
  });
});

// specs/hunk-line-staging.md FR-479/FR-480/FR-478: the checkbox model's IPC handlers.
describe("combined-diff IPC handlers", () => {
  type Handler = (evt: unknown, ...args: unknown[]) => Promise<{ ok: boolean; error?: { name: string; message: string } }>;

  async function getHandler(channel: string): Promise<Handler> {
    await import("./main");
    const call = ipcHandleMock.mock.calls.find(([c]) => c === channel);
    if (!call) throw new Error(`${channel} handler was never registered`);
    return call[1] as Handler;
  }

  beforeEach(() => {
    vi.resetModules();
    ipcHandleMock.mockClear();
    partialStagingCalls.length = 0;
    partialStagingBehavior.error = null;
  });

  it("getCombinedFileDiff forwards only the path", async () => {
    const get = await getHandler(IPC_CHANNELS.getCombinedFileDiff);
    await get(undefined, "a.ts", { contextLines: 99 });
    expect(partialStagingCalls).toEqual([{ method: "getCombinedFileDiff", args: ["a.ts"] }]);
  });

  it("toggleCombinedLines rebuilds each ref from two integers (extra fields dropped) and forwards the target", async () => {
    const toggle = await getHandler(IPC_CHANNELS.toggleCombinedLines);
    const result = await toggle(undefined, "a.ts", "fp", [{ hunkIndex: 0, lineIndex: 2, extra: "dropped" }, { hunkIndex: 1, lineIndex: 0 }], "unstage");
    expect(result.ok).toBe(true);
    expect(partialStagingCalls).toEqual([
      {
        method: "toggleCombinedLines",
        args: ["a.ts", "fp", [{ hunkIndex: 0, lineIndex: 2 }, { hunkIndex: 1, lineIndex: 0 }], "unstage"],
      },
    ]);
  });

  it("discardCombinedLines calls the matching repository method with sanitized refs", async () => {
    const discard = await getHandler(IPC_CHANNELS.discardCombinedLines);
    await discard(undefined, "a.ts", "fp", [{ hunkIndex: 3, lineIndex: 4 }]);
    expect(partialStagingCalls).toEqual([
      { method: "discardCombinedLines", args: ["a.ts", "fp", [{ hunkIndex: 3, lineIndex: 4 }]] },
    ]);
  });

  it("rejects a non-string path or fingerprint as InvalidArgumentError without reaching git-core", async () => {
    const ok = [{ hunkIndex: 0, lineIndex: 0 }];
    const toggle = await getHandler(IPC_CHANNELS.toggleCombinedLines);
    for (const [path, fp] of [[{ toString: () => "x" }, "fp"], ["a.ts", 42], [null, "fp"], ["a.ts", undefined], [["a.ts"], "fp"]]) {
      const r = await toggle(undefined, path, fp, ok, "stage");
      expect(r.error?.name).toBe("InvalidArgumentError");
    }
    const discard = await getHandler(IPC_CHANNELS.discardCombinedLines);
    expect((await discard(undefined, 7, "fp", ok)).error?.name).toBe("InvalidArgumentError");
    expect((await discard(undefined, "a.ts", {}, ok)).error?.name).toBe("InvalidArgumentError");
    const get = await getHandler(IPC_CHANNELS.getCombinedFileDiff);
    expect((await get(undefined, { path: "a.ts" })).error?.name).toBe("InvalidArgumentError");
    expect(partialStagingCalls).toEqual([]);
  });

  it("whole-file discard handlers forward only the path and the required fingerprint; getDiscardFingerprint forwards path and kind", async () => {
    await (await getHandler(IPC_CHANNELS.getDiscardFingerprint))(undefined, "a.ts", "tracked");
    await (await getHandler(IPC_CHANNELS.discardTrackedFileChanges))(undefined, "a.ts", "fp1", { onBackup: "x" });
    await (await getHandler(IPC_CHANNELS.discardUntrackedFile))(undefined, "b.ts", "fp2");
    expect(partialStagingCalls).toEqual([
      { method: "getDiscardFingerprint", args: ["a.ts", "tracked"] },
      { method: "discardTrackedFileChanges", args: ["a.ts", { expectedFingerprint: "fp1" }] },
      { method: "discardUntrackedFile", args: ["b.ts", { expectedFingerprint: "fp2" }] },
    ]);
  });

  it("rejects a non-string path/fingerprint or bad kind on the discard handlers without reaching git-core", async () => {
    const t = await getHandler(IPC_CHANNELS.discardTrackedFileChanges);
    const u = await getHandler(IPC_CHANNELS.discardUntrackedFile);
    const g = await getHandler(IPC_CHANNELS.getDiscardFingerprint);
    for (const r of [
      await t(undefined, "a.ts", undefined),
      await t(undefined, "a.ts", 5),
      await t(undefined, { x: 1 }, "fp"),
      await u(undefined, "a.ts"),
      await u(undefined, ["a"], "fp"),
      await g(undefined, "a.ts", "other"),
      await g(undefined, 3, "tracked"),
    ]) {
      expect(r.error?.name).toBe("InvalidArgumentError");
    }
    expect(partialStagingCalls).toEqual([]);
  });

  it("rejects malformed refs or a bad target as InvalidArgumentError without reaching git-core", async () => {
    const toggle = await getHandler(IPC_CHANNELS.toggleCombinedLines);
    const bads: unknown[][] = [
      ["x", "stage"],
      [[{ hunkIndex: "1", lineIndex: 0 }], "stage"],
      [[{ hunkIndex: 0, lineIndex: 1.5 }], "stage"],
      [[{ hunkIndex: -1, lineIndex: 0 }], "stage"],
      [[null], "stage"],
      [[{ hunkIndex: 0, lineIndex: 0 }], "discard"],
    ];
    for (const [lines, target] of bads) {
      const result = await toggle(undefined, "a.ts", "fp", lines, target);
      expect(result.ok).toBe(false);
      expect(result.error?.name).toBe("InvalidArgumentError");
    }
    const discard = await getHandler(IPC_CHANNELS.discardCombinedLines);
    expect((await discard(undefined, "a.ts", "fp", "nope")).error?.name).toBe("InvalidArgumentError");
    expect(partialStagingCalls).toEqual([]);
  });

  it.each([
    ["StaleDiffError", (m: typeof import("@githydra/git-core")) => new m.StaleDiffError("a.ts")],
    ["PartialStagingIneligibleError", (m: typeof import("@githydra/git-core")) => new m.PartialStagingIneligibleError("a.ts", "ambiguous")],
    ["LinesNotDiscardableError", (m: typeof import("@githydra/git-core")) => new m.LinesNotDiscardableError("a.ts", [{ hunkIndex: 0, lineIndex: 0 }])],
  ])("carries %s's name across IPC", async (name, make) => {
    const mod = await import("@githydra/git-core");
    partialStagingBehavior.error = make(mod);
    const toggle = await getHandler(IPC_CHANNELS.toggleCombinedLines);
    const result = await toggle(undefined, "a.ts", "fp", [{ hunkIndex: 0, lineIndex: 0 }], "stage");
    expect(result).toMatchObject({ ok: false, error: { name } });
  });
});


// specs/ignore-and-multiselect.md FR-499/FR-502/FR-507/FR-508: the new handlers rebuild every argument from known fields,
// refuse malformed input before git-core, and refresh the watcher's ignore list after any ignore write.
describe("ignore and bulk IPC handlers", () => {
  type Handler = (
    evt: unknown,
    ...args: unknown[]
  ) => Promise<{ ok: boolean; error?: { name: string; message: string; code?: string; details?: Record<string, unknown> } }>;

  async function getHandler(channel: string): Promise<Handler> {
    await import("./main");
    const call = ipcHandleMock.mock.calls.find(([c]) => c === channel);
    if (!call) throw new Error(`${channel} handler was never registered`);
    return call[1] as Handler;
  }

  beforeEach(() => {
    vi.resetModules();
    ipcHandleMock.mockClear();
    partialStagingCalls.length = 0;
    partialStagingBehavior.error = null;
  });

  it("planIgnore forwards only paths/scope/target and an explicit stopTracking flag", async () => {
    const plan = await getHandler(IPC_CHANNELS.planIgnore);
    await plan(undefined, { paths: ["a.log"], scope: "extension", target: "exclude", stopTracking: true, extra: "dropped" });
    await plan(undefined, { paths: ["b"], scope: "name", target: "root", stopTracking: "yes" });
    expect(partialStagingCalls).toEqual([
      { method: "planIgnore", args: [{ paths: ["a.log"], scope: "extension", target: "exclude", stopTracking: true }] },
      { method: "planIgnore", args: [{ paths: ["b"], scope: "name", target: "root", stopTracking: false }] },
    ]);
  });

  it("ignorePaths and ignoreAndStopTracking forward a rebuilt request and refresh the watcher ignore list afterwards, even when the write fails", async () => {
    const ignore = await getHandler(IPC_CHANNELS.ignorePaths);
    const stop = await getHandler(IPC_CHANNELS.ignoreAndStopTracking);
    await ignore(undefined, { paths: ["a"], scope: "name", target: "nearest", stopTracking: true });
    partialStagingBehavior.error = new Error("boom");
    const failed = await stop(undefined, { paths: ["b/"], scope: "directory", target: "exclude", expectedUntrackPaths: ["b/x"] });
    expect(failed.ok).toBe(false);
    expect(partialStagingCalls).toEqual([
      { method: "ignorePaths", args: [{ paths: ["a"], scope: "name", target: "nearest" }] },
      { method: "refreshWorktreeIgnoreList", args: [] },
      { method: "ignoreAndStopTracking", args: [{ paths: ["b/"], scope: "directory", target: "exclude", expectedUntrackPaths: ["b/x"] }] },
      { method: "refreshWorktreeIgnoreList", args: [] },
    ]);
  });

  it("forwards expectedUntrackPaths to ignoreAndStopTracking only, validated as a string array (security L2)", async () => {
    const ignore = await getHandler(IPC_CHANNELS.ignorePaths);
    const plan = await getHandler(IPC_CHANNELS.planIgnore);
    const stop = await getHandler(IPC_CHANNELS.ignoreAndStopTracking);
    const req = { paths: ["a"], scope: "name", target: "root", expectedUntrackPaths: ["a", "b"] };
    await stop(undefined, req);
    await ignore(undefined, req);
    await plan(undefined, req);
    expect(partialStagingCalls.filter((c) => c.method !== "refreshWorktreeIgnoreList")).toEqual([
      { method: "ignoreAndStopTracking", args: [{ paths: ["a"], scope: "name", target: "root", expectedUntrackPaths: ["a", "b"] }] },
      { method: "ignorePaths", args: [{ paths: ["a"], scope: "name", target: "root" }] },
      { method: "planIgnore", args: [{ paths: ["a"], scope: "name", target: "root", stopTracking: false }] },
    ]);
    partialStagingCalls.length = 0;
    for (const bad of ["a", [1], [{}]]) {
      expect((await stop(undefined, { ...req, expectedUntrackPaths: bad })).error?.name).toBe("InvalidArgumentError");
    }
    expect(partialStagingCalls.filter((c) => c.method === "ignoreAndStopTracking")).toEqual([]);
    // Stop tracking acts only on the confirmed list: without one it is refused.
    const { expectedUntrackPaths: _omit, ...noList } = req;
    expect((await stop(undefined, noList)).error?.name).toBe("InvalidArgumentError");
    expect(partialStagingCalls.filter((c) => c.method === "ignoreAndStopTracking")).toEqual([]);
  });

  it("getDiscardPreview forwards at most 50 string paths and nothing else", async () => {
    const preview = await getHandler(IPC_CHANNELS.getDiscardPreview);
    partialStagingCalls.length = 0;
    await preview(undefined, ["a", "b"]);
    expect(partialStagingCalls).toEqual([{ method: "getDiscardPreview", args: [["a", "b"]] }]);
    partialStagingCalls.length = 0;
    expect((await preview(undefined, Array.from({ length: 51 }, (_, i) => `f${i}`))).ok).toBe(false);
    expect((await preview(undefined, [1])).ok).toBe(false);
    expect((await preview(undefined, "a")).ok).toBe(false);
    expect(partialStagingCalls).toEqual([]);
  });

  it("caps discard/fingerprint calls at git-core's row limit with a message the dialog can show", async () => {
    const bulk = await getHandler(IPC_CHANNELS.bulkDiscard);
    const fps = await getHandler(IPC_CHANNELS.getBulkDiscardFingerprints);
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `f${i}`, section: "unstaged", expectedFingerprint: "x" }));
    const r = await bulk(undefined, many(3001));
    expect(r.error).toMatchObject({ name: "InvalidArgumentError", message: "Too many files, discard in chunks." });
    expect((await fps(undefined, many(3001))).error?.message).toBe("Too many files, discard in chunks.");
    expect((await bulk(undefined, many(3000))).ok).toBe(true);
  });

  it("carries IgnorePlanChangedError and StaleBatchError bounded lists plus real counts across IPC", async () => {
    const stop = await getHandler(IPC_CHANNELS.ignoreAndStopTracking);
    const bulk = await getHandler(IPC_CHANNELS.bulkDiscard);
    const mod = await import("@githydra/git-core");
    const big = Array.from({ length: 500 }, (_, i) => `p${i}`);
    partialStagingBehavior.error = new mod.IgnorePlanChangedError(big, ["x"]);
    const r = await stop(undefined, { paths: ["a"], scope: "name", target: "root", expectedUntrackPaths: ["a"] });
    expect(r.error).toMatchObject({
      name: "IgnorePlanChangedError",
      code: "IGNORE_PLAN_CHANGED",
      details: { actual: ["x"], expectedCount: 500, actualCount: 1 },
    });
    expect((r.error!.details!.expected as string[]).length).toBeLessThanOrEqual(50);
    partialStagingBehavior.error = new mod.StaleBatchError(big);
    const s = await bulk(undefined, [{ path: "a", section: "unstaged", expectedFingerprint: "fp" }]);
    expect((s.error!.details!.paths as string[]).length).toBeLessThanOrEqual(50);
    expect(s.error!.details!.totalPaths).toBe(500);
  });

  it("rejects malformed ignore requests as InvalidArgumentError without reaching git-core", async () => {
    const ignore = await getHandler(IPC_CHANNELS.ignorePaths);
    for (const req of [
      null,
      { paths: "a", scope: "name", target: "root" },
      { paths: [1], scope: "name", target: "root" },
      { paths: ["a"], scope: "glob", target: "root" },
      { paths: ["a"], scope: "name", target: "global" },
      { paths: ["a"], scope: "name" },
    ]) {
      expect((await ignore(undefined, req)).error?.name).toBe("InvalidArgumentError");
    }
    expect(partialStagingCalls.filter((c) => c.method === "ignorePaths")).toEqual([]);
  });

  it("caps ignore paths at git-core's IGNORE_ROW_LIMIT before reaching git-core", async () => {
    const ignore = await getHandler(IPC_CHANNELS.ignorePaths);
    const paths = Array.from({ length: 3001 }, (_, i) => `f${i}`);
    expect((await ignore(undefined, { paths, scope: "name", target: "root" })).error?.name).toBe("InvalidArgumentError");
    expect(partialStagingCalls.filter((c) => c.method === "ignorePaths")).toEqual([]);
  });

  it("stagePaths/unstagePaths rebuild rows from path and a known section only", async () => {
    const stage = await getHandler(IPC_CHANNELS.stagePaths);
    const unstage = await getHandler(IPC_CHANNELS.unstagePaths);
    await stage(undefined, [{ path: "a", section: "mixed", evil: 1 }]);
    await unstage(undefined, [{ path: "b", section: "staged" }]);
    expect(partialStagingCalls).toEqual([
      { method: "stagePaths", args: [[{ path: "a", section: "mixed" }]] },
      { method: "unstagePaths", args: [[{ path: "b", section: "staged" }]] },
    ]);
    for (const rows of ["a", [null], [{ path: 1, section: "staged" }], [{ path: "a", section: "bogus" }], [{ path: "a" }]]) {
      expect((await stage(undefined, rows)).error?.name).toBe("InvalidArgumentError");
    }
    expect(partialStagingCalls).toHaveLength(2);
  });

  it("bulkDiscard requires a string fingerprint on every row and a discardable section", async () => {
    const bulk = await getHandler(IPC_CHANNELS.bulkDiscard);
    await bulk(undefined, [{ path: "a", section: "unstaged", expectedFingerprint: "fp1", extra: true }]);
    expect(partialStagingCalls).toEqual([
      { method: "bulkDiscard", args: [[{ path: "a", section: "unstaged", expectedFingerprint: "fp1" }]] },
    ]);
    partialStagingCalls.length = 0;
    for (const rows of [
      [{ path: "a", section: "unstaged" }],
      [{ path: "a", section: "unstaged", expectedFingerprint: 5 }],
      [{ path: "a", section: "staged", expectedFingerprint: "fp" }],
      "nope",
    ]) {
      expect((await bulk(undefined, rows)).error?.name).toBe("InvalidArgumentError");
    }
    expect(partialStagingCalls).toEqual([]);
  });

  it("discardAllChanges forwards rows plus a strict boolean includeUntracked; getBulkDiscardFingerprints forwards candidates only", async () => {
    const all = await getHandler(IPC_CHANNELS.discardAllChanges);
    const fps = await getHandler(IPC_CHANNELS.getBulkDiscardFingerprints);
    const row = { path: "a", section: "untracked", expectedFingerprint: "fp" };
    await all(undefined, [row], true);
    await all(undefined, [row], "true");
    await fps(undefined, [{ path: "a", section: "mixed", expectedFingerprint: "ignored" }]);
    expect(partialStagingCalls).toEqual([
      { method: "discardAllChanges", args: [{ rows: [row], includeUntracked: true }] },
      { method: "discardAllChanges", args: [{ rows: [row], includeUntracked: false }] },
      { method: "getBulkDiscardFingerprints", args: [[{ path: "a", section: "mixed" }]] },
    ]);
  });

  it("planDiscardAll takes no renderer arguments", async () => {
    const plan = await getHandler(IPC_CHANNELS.planDiscardAll);
    await plan(undefined, { anything: 1 });
    expect(partialStagingCalls).toEqual([{ method: "planDiscardAll", args: [] }]);
  });

  it("carries each bulk error's code and whitelisted fields across IPC", async () => {
    const mod = await import("@githydra/git-core");
    const bulk = await getHandler(IPC_CHANNELS.bulkDiscard);
    const stage = await getHandler(IPC_CHANNELS.stagePaths);
    const ignore = await getHandler(IPC_CHANNELS.ignoreAndStopTracking);
    const row = [{ path: "a", section: "unstaged", expectedFingerprint: "fp" }];

    partialStagingBehavior.error = new mod.StaleBatchError(["a", "b"]);
    expect((await bulk(undefined, row)).error).toMatchObject({
      name: "StaleBatchError",
      code: "STALE_DIFF",
      details: { paths: ["a", "b"] },
    });

    partialStagingBehavior.error = new mod.BulkStagingError(["x"], ["y", "z"], "index.lock");
    expect((await stage(undefined, [{ path: "y", section: "unstaged" }])).error).toMatchObject({
      name: "BulkStagingError",
      code: "BULK_STAGING_FAILED",
      details: { changed: ["x"], unchanged: ["y", "z"], gitMessage: "index.lock" },
    });

    partialStagingBehavior.error = new mod.IgnoreUntrackError(false, [".gitignore"], "boom");
    expect((await ignore(undefined, { paths: ["a"], scope: "name", target: "root", expectedUntrackPaths: ["a"] })).error).toMatchObject({
      name: "IgnoreUntrackError",
      code: "IGNORE_UNTRACK_FAILED",
      details: { rolledBack: false, ruleFilesLeftModified: [".gitignore"], gitMessage: "boom" },
    });

    partialStagingBehavior.error = new mod.IgnoreFileChangedError(".gitignore");
    expect((await ignore(undefined, { paths: ["a"], scope: "name", target: "root", expectedUntrackPaths: ["a"] })).error).toMatchObject({
      name: "IgnoreFileChangedError",
      code: "IGNORE_FILE_CHANGED",
      details: { file: ".gitignore" },
    });
  });
});

// specs/edit-in-diff.md FR-468/FR-471/FR-474/FR-536: the three edit channels and the own-save echo suppression.
describe("edit-file IPC handlers", () => {
  type Handler = (evt: unknown, ...args: unknown[]) => Promise<{ ok: boolean; code?: string; data?: unknown }>;
  let tmpRoot: string;

  async function getHandler(channel: string): Promise<Handler> {
    await import("./main");
    const call = ipcHandleMock.mock.calls.find(([c]) => c === channel);
    if (!call) throw new Error(`${channel} handler was never registered`);
    return call[1] as Handler;
  }
  const opts = { expectedHash: "a".repeat(64), eol: "lf", hasBom: false, finalNewline: true };

  beforeEach(async () => {
    vi.resetModules();
    ipcHandleMock.mockClear();
    partialStagingCalls.length = 0;
    partialStagingBehavior.error = null;
    fakeEdit.worktreeCallback = null;
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-edit-ipc-"));
    fakeRepoState.workdir = tmpRoot;
  });
  afterEach(async () => {
    fakeRepoState.workdir = undefined;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("validates before git-core and returns typed codes, never raw errors", async () => {
    const write = await getHandler(IPC_CHANNELS.writeEditedFile);
    const probe = await getHandler(IPC_CHANNELS.probeEditableFile);
    const read = await getHandler(IPC_CHANNELS.readEditableFile);
    expect(await write(undefined, 7, "x", opts)).toMatchObject({ ok: false, code: "invalid-argument" });
    expect(await write(undefined, "a.txt", "x", { ...opts, eol: "bogus" })).toMatchObject({ ok: false, code: "invalid-argument" });
    expect(await write(undefined, "a.txt", "x".repeat(2 * 1024 * 1024 + 1), opts)).toMatchObject({ ok: false, code: "content-too-large" });
    expect(await probe(undefined, {})).toMatchObject({ ok: false, code: "invalid-argument" });
    expect(await read(undefined, "a\0b")).toMatchObject({ ok: false, code: "invalid-argument" });
    expect(partialStagingCalls).toEqual([]);
    expect(await write(undefined, "a.txt", "x", { ...opts, evil: 1 })).toMatchObject({ ok: true });
    expect(partialStagingCalls).toEqual([{ method: "writeEditedFile", args: ["a.txt", "x", opts] }]);
  });

  it("drops the work-tree event for our own save but forwards any other change", async () => {
    const file = path.join(tmpRoot, "a.txt");
    await fs.writeFile(file, "hello");
    const st = await fs.stat(file, { bigint: true });
    fakeEdit.writeResult = { status: "written", contentHash: "b".repeat(64), mtimeMs: Number(st.mtimeNs) / 1e6, size: Number(st.size) };

    const openRepo = await getHandler(IPC_CHANNELS.openRepo);
    await openRepo(undefined, tmpRoot);
    const send = browserWindowState.instances.at(-1)!.webContents.send as ReturnType<typeof vi.fn>;
    send.mockClear();
    const write = await getHandler(IPC_CHANNELS.writeEditedFile);
    expect(await write(undefined, "a.txt", "hello", opts)).toMatchObject({ ok: true, data: { status: "written" } });

    const cb = fakeEdit.worktreeCallback!;
    cb({ paths: ["a.txt"], truncated: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(send).not.toHaveBeenCalledWith(IPC_CHANNELS.worktreeChangedEvent);

    cb({ paths: ["a.txt", "b.txt"], truncated: false });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(IPC_CHANNELS.worktreeChangedEvent));
    send.mockClear();
    cb(undefined);
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.worktreeChangedEvent);

    send.mockClear();
    await fs.writeFile(file, "changed by someone else");
    cb({ paths: ["a.txt"], truncated: false });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(IPC_CHANNELS.worktreeChangedEvent));
  });
});

// specs/edit-in-diff.md FR-535 (M1): main intercepts the window close while the renderer reports unsaved edits.
describe("app close interception (FR-535)", () => {
  const handler = (channel: string) => {
    const call = ipcHandleMock.mock.calls.find(([c]) => c === channel);
    if (!call) throw new Error(`${channel} handler was never registered`);
    return call[1] as (evt: unknown, arg: unknown) => Promise<{ ok: boolean; error?: { name: string } }>;
  };
  const closeEvent = () => ({ prevented: false, preventDefault() { this.prevented = true; } });

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    ipcHandleMock.mockClear();
    browserWindowState.instances.length = 0;
    vi.mocked(dialog.showMessageBox).mockClear();
    vi.mocked(app.on).mockClear();
    vi.mocked(app.quit).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("does not intercept a close when nothing is dirty", async () => {
    await import("./main");
    const win = firstBrowserWindowInstance();
    const ev = closeEvent();
    win.__emit("close", ev);
    expect(ev.prevented).toBe(false);
    expect(win.webContents.send).not.toHaveBeenCalledWith(IPC_CHANNELS.closeRequestedEvent);
  });

  it("prevents a dirty close and sends the typed close-requested event", async () => {
    await import("./main");
    const win = firstBrowserWindowInstance();
    await handler(IPC_CHANNELS.setEditDirty)(undefined, true);
    const ev = closeEvent();
    win.__emit("close", ev);
    expect(ev.prevented).toBe(true);
    expect(win.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.closeRequestedEvent);
    expect(win.close).not.toHaveBeenCalled();
  });

  it("closes the window when the renderer answers allow", async () => {
    await import("./main");
    const win = firstBrowserWindowInstance();
    await handler(IPC_CHANNELS.setEditDirty)(undefined, true);
    win.__emit("close", closeEvent());
    expect((await handler(IPC_CHANNELS.confirmClose)(undefined, "allow")).ok).toBe(true);
    expect(win.close).toHaveBeenCalledTimes(1);
    const second = closeEvent();
    win.__emit("close", second);
    expect(second.prevented).toBe(false);
  });

  it("keeps the window open when the renderer answers cancel", async () => {
    await import("./main");
    const win = firstBrowserWindowInstance();
    await handler(IPC_CHANNELS.setEditDirty)(undefined, true);
    win.__emit("close", closeEvent());
    await handler(IPC_CHANNELS.confirmClose)(undefined, "cancel");
    expect(win.close).not.toHaveBeenCalled();
  });

  it("falls back to a native confirm when the renderer never answers, and keeps the window on Keep open", async () => {
    await import("./main");
    const win = firstBrowserWindowInstance();
    await handler(IPC_CHANNELS.setEditDirty)(undefined, true);
    win.__emit("close", closeEvent());
    await vi.advanceTimersByTimeAsync(5000);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(win.close).not.toHaveBeenCalled();
  });

  it("uses 'not responding' wording only for a silent renderer, neutral wording for a second close with the prompt open", async () => {
    await import("./main");
    const win = firstBrowserWindowInstance();
    await handler(IPC_CHANNELS.setEditDirty)(undefined, true);
    win.__emit("close", closeEvent());
    await vi.advanceTimersByTimeAsync(5000);
    const first = vi.mocked(dialog.showMessageBox).mock.calls.at(-1)!;
    expect(JSON.stringify(first)).toContain("GitHydra is not responding");

    win.__emit("close", closeEvent());
    await handler(IPC_CHANNELS.confirmClose)(undefined, "prompting");
    win.__emit("close", closeEvent());
    await vi.advanceTimersByTimeAsync(0);
    const second = JSON.stringify(vi.mocked(dialog.showMessageBox).mock.calls.at(-1));
    expect(second).toContain("Close GitHydra?");
    expect(second).not.toContain("not responding");
    expect(second).toContain("already open in the window");
  });

  it("closes after the native confirm says Close anyway", async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    await import("./main");
    const win = firstBrowserWindowInstance();
    await handler(IPC_CHANNELS.setEditDirty)(undefined, true);
    win.__emit("close", closeEvent());
    await vi.advanceTimersByTimeAsync(5000);
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-boolean dirty flag and an unknown reply as invalid arguments", async () => {
    await import("./main");
    const dirty = await handler(IPC_CHANNELS.setEditDirty)(undefined, "yes");
    expect(dirty.ok).toBe(false);
    expect(dirty.error?.name).toBe("InvalidArgumentError");
    const reply = await handler(IPC_CHANNELS.confirmClose)(undefined, { allow: true });
    expect(reply.ok).toBe(false);
    expect(reply.error?.name).toBe("InvalidArgumentError");
    const win = firstBrowserWindowInstance();
    const ev = closeEvent();
    win.__emit("close", ev);
    expect(ev.prevented).toBe(false);
  });

  it("a renderer reload clears the dirty flag", async () => {
    await import("./main");
    const win = firstBrowserWindowInstance();
    await handler(IPC_CHANNELS.setEditDirty)(undefined, true);
    win.webContents.__emit("did-start-navigation", undefined, "file:///index.html", false, true);
    const ev = closeEvent();
    win.__emit("close", ev);
    expect(ev.prevented).toBe(false);
  });

  it("does not veto a Windows session end", async () => {
    await import("./main");
    const win = firstBrowserWindowInstance();
    await handler(IPC_CHANNELS.setEditDirty)(undefined, true);
    win.__emit("query-session-end");
    const ev = closeEvent();
    win.__emit("close", ev);
    expect(ev.prevented).toBe(false);
  });

  it("ignores close-guard calls from a sender that is not the main window", async () => {
    await import("./main");
    const win = firstBrowserWindowInstance();
    const r = await handler(IPC_CHANNELS.setEditDirty)({ sender: {} }, true);
    expect(r.ok).toBe(false);
    const ev = closeEvent();
    win.__emit("close", ev);
    expect(ev.prevented).toBe(false);
  });

  it("completes a Cmd+Q quit after the renderer allows it", async () => {
    await import("./main");
    const win = firstBrowserWindowInstance();
    const beforeQuit = vi.mocked(app.on).mock.calls.find(([name]) => name === "before-quit")?.[1] as (() => void) | undefined;
    expect(beforeQuit).toBeTypeOf("function");
    await handler(IPC_CHANNELS.setEditDirty)(undefined, true);
    beforeQuit!();
    win.__emit("close", closeEvent());
    await handler(IPC_CHANNELS.confirmClose)(undefined, "allow");
    expect(app.quit).toHaveBeenCalled();
  });
});

// specs/edit-recovery-draft.md FR-547/FR-554/FR-555: main wiring of the four draft channels and the start-up purge.
describe("recovery draft wiring", () => {
  type H = (evt: unknown, ...args: unknown[]) => Promise<{ ok: boolean; code?: string; data?: unknown; message?: string }>;
  let tmpRoot: string;
  let userData: string;
  const draft = { content: "hi\n", bom: false, eol: "lf", finalNewline: true, expectedHash: "d".repeat(64) };
  const REPO = () => fakeRepoState.workdir as string;
  const ok = () => ({ sender: browserWindowState.instances[0]!.webContents });
  const get = (channel: string): H => {
    const call = ipcHandleMock.mock.calls.find(([c]) => c === channel);
    if (!call) throw new Error(`${channel} handler was never registered`);
    return call[1] as H;
  };

  beforeEach(async () => {
    vi.resetModules();
    ipcHandleMock.mockClear();
    browserWindowState.instances.length = 0;
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-draft-main-"));
    userData = path.join(tmpRoot, "userData");
    await fs.mkdir(userData);
    fakeUserDataPath.value = userData;
    fakeRepoState.workdir = path.join(tmpRoot, "repo");
    await fs.mkdir(fakeRepoState.workdir);
  });
  afterEach(async () => {
    fakeRepoState.workdir = undefined;
    fakeUserDataPath.value = "C:\githydra-test-userdata-does-not-exist";
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("registers exactly the four channels and stores only under userData/recovery-drafts", async () => {
    await import("./main");
    const w = await get(IPC_CHANNELS.writeDraft)(ok(), REPO(), "a.txt", draft);
    expect(w).toMatchObject({ ok: true, data: { status: "saved" } });
    expect(await get(IPC_CHANNELS.readDraft)(ok(), REPO(), "a.txt")).toMatchObject({ ok: true, data: { content: "hi\n" } });
    expect(await get(IPC_CHANNELS.listDrafts)(ok(), REPO())).toMatchObject({ ok: true, data: [{ relativePath: "a.txt" }] });
    expect(await fs.readdir(path.join(tmpRoot, "repo"))).toEqual([]);
    expect(await fs.readdir(path.join(userData, "recovery-drafts"))).toHaveLength(1);
    expect(await get(IPC_CHANNELS.deleteDraft)(ok(), REPO(), "a.txt")).toMatchObject({ ok: true });
  });

  it("refuses a sender that is not the main window and validates the rest", async () => {
    await import("./main");
    const foreign = { sender: {} };
    expect(await get(IPC_CHANNELS.writeDraft)(foreign, REPO(), "a.txt", draft)).toMatchObject({ ok: false, code: "invalid-argument" });
    expect(await get(IPC_CHANNELS.readDraft)(foreign, REPO(), "a.txt")).toMatchObject({ ok: false, code: "invalid-argument" });
    expect(await get(IPC_CHANNELS.deleteDraft)(foreign, REPO(), "a.txt")).toMatchObject({ ok: false, code: "invalid-argument" });
    expect(await get(IPC_CHANNELS.listDrafts)(foreign, REPO())).toMatchObject({ ok: false, code: "invalid-argument" });
    expect(await get(IPC_CHANNELS.listDrafts)(undefined, REPO())).toMatchObject({ ok: false, code: "invalid-argument" }); // fail closed
    await expect(fs.stat(path.join(userData, "recovery-drafts"))).rejects.toThrow();
    expect(await get(IPC_CHANNELS.writeDraft)(ok(), REPO(), "../x", draft)).toMatchObject({ ok: false, code: "invalid-argument" });
  });

  it("purges at start asynchronously, after the window exists", async () => {
    const dir = path.join(userData, "recovery-drafts", "a".repeat(64));
    await fs.mkdir(dir, { recursive: true });
    const corrupt = path.join(dir, `${"b".repeat(64)}.json`);
    await fs.writeFile(corrupt, "{corrupt");
    await import("./main");
    expect(browserWindowState.instances.length).toBe(1);
    await expect(fs.stat(corrupt)).resolves.toBeTruthy(); // not purged synchronously: startup did not wait for it
    await vi.waitFor(async () => {
      await expect(fs.stat(corrupt)).rejects.toThrow();
    });
  });
});
