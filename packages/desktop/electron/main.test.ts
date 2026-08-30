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
const { ipcHandleMock, fakeRepoState, FakeRepoSession } = vi.hoisted(() => {
  const fakeRepoState: { workdir: string | undefined } = { workdir: undefined };
  class FakeRepoSession {
    getOpenRepo() {
      return { getState: () => ({ workdir: fakeRepoState.workdir }) };
    }
    startWatch() {}
    dispose() {}
  }
  return { ipcHandleMock: vi.fn(), fakeRepoState, FakeRepoSession };
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
  },
  // `main.ts` calls `new BrowserWindow(...)`, so the mock must be a real constructor — an arrow
  // function (or `mockImplementation(() => ...)`) isn't callable with `new`.
  BrowserWindow: Object.assign(
    function BrowserWindowMock() {
      return {
        on: vi.fn(),
        loadURL: vi.fn(),
        loadFile: vi.fn(),
        webContents: { setWindowOpenHandler: vi.fn(), send: vi.fn() },
      };
    },
    { getAllWindows: () => [] },
  ),
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: ipcHandleMock },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

// `RepoSession` normally shells out to real git via `Repository.open`. This handler only ever
// touches `session.getOpenRepo().getState()`, so a minimal fake is enough — configured per-test
// by mutating `fakeRepoState.workdir`. `main.ts` calls `new RepoSession()`, so this must be a real
// class (an arrow function isn't a valid constructor and throws "is not a constructor").
vi.mock("./repoSession", () => ({
  RepoSession: FakeRepoSession,
}));

import { IPC_CHANNELS } from "../shared/ipcContract";
import { shell } from "electron";

async function getOpenPathHandler() {
  await import("./main");
  const call = ipcHandleMock.mock.calls.find(([channel]) => channel === IPC_CHANNELS.openPathInExternalEditor);
  if (!call) throw new Error("openPathInExternalEditor handler was never registered");
  return call[1] as (evt: unknown, filePath: string) => Promise<{ ok: boolean; error?: { name: string } }>;
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
