// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GITHYDRA_TAB_ID } from "../shared/programsContract";
import type { SpawnFn } from "./programs/launcher";
import type { RuleEnv } from "./programs/exeRules";
import { chooseSpawnFn, createSpawnRecorder, E2E_SPAWN_RECORD_ENV } from "./programs/e2eSpawnRecorder";
import { createFileProgramStore, emptyRecords, validateRecords, type ProgramRecords } from "./programs/programStore";
import { createProgramsService } from "./programs/programsService";
import { createProgramsHandlers, parseLaunchRequest, type ProgramsRepo } from "./programsIpc";

/** specs/external-programs.md AC5/AC6: records are main-only, the launch IPC takes ids, folders are verified in main. */

const HOME = "C:\\Users\\a";
const CODE = "C:\\Tools\\Code\\Code.exe";
const OTHER = "C:\\Tools\\Zed\\Zed.exe";

function makeEnv(files: string[], extra: { repo?: string[]; detected?: string[] } = {}): { env: RuleEnv; files: Set<string> } {
  const set = new Set(files);
  const env: RuleEnv = {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", ELECTRON_RUN_AS_NODE: "1", Path: "C:\\x" },
    runCommand: async () => "",
    exists: async (p) => set.has(p),
    isDirectory: async (p) => p.endsWith("\\repo") || p === "C:\\work\\main" || p === "C:\\work\\wt",
    realpath: async (p) => p,
    readHead: async () => Uint8Array.from([0x4d, 0x5a]),
    hasGitAncestor: async (p) => (extra.repo ?? []).some((r) => p.startsWith(r)),
    readdir: async () => [],
  };
  return { env, files: set };
}

function memoryStore(initial: ProgramRecords = emptyRecords()) {
  let rec = structuredClone(initial);
  return { read: async () => structuredClone(rec), write: async (r: ProgramRecords) => void (rec = structuredClone(r)), peek: () => rec };
}

function setup(opts: { files?: string[]; picks?: (string | null)[]; repo?: string[]; initial?: ProgramRecords; spawn?: SpawnFn } = {}) {
  const { env, files } = makeEnv(opts.files ?? [CODE, OTHER], { repo: opts.repo });
  const store = memoryStore(opts.initial);
  const picks = [...(opts.picks ?? [])];
  const spawnFn: SpawnFn = opts.spawn ?? (vi.fn(() => ({ unref: () => undefined })) as unknown as SpawnFn);
  const service = createProgramsService({ store, env, home: HOME, spawnFn, pickFile: async () => picks.shift() ?? null, newPendingId: () => "pending-1" });
  const repo: ProgramsRepo = {
    getState: () => ({ workdir: "C:\\work\\repo", isBare: false }),
    listWorktrees: async () => ({ entries: [{ id: null, path: "C:\\work\\main", isMain: true, isBare: false }], untrusted: false, mainPath: "C:\\work\\main", mainPathIsGitDir: false }) as never,
    verifyRegisteredWorktree: async (id) => (id === "wt" ? { trusted: true, id, path: "C:\\work\\wt", realPath: "C:\\work\\wt" } : { trusted: false, reason: "not-registered" }),
  };
  const handlers = createProgramsHandlers(service, () => repo);
  return { handlers, store, spawnFn, files, repo };
}

describe("parseLaunchRequest (FR-642)", () => {
  it("accepts exactly { programId, target } with a worktreeId, repoRoot or mainWorktree target", () => {
    expect(parseLaunchRequest({ programId: "vscode", target: { worktreeId: "wt" } })).toEqual({ programId: "vscode", target: { worktreeId: "wt" } });
    expect(parseLaunchRequest({ programId: "vscode", target: { repoRoot: true } })).toEqual({ programId: "vscode", target: { repoRoot: true } });
    expect(parseLaunchRequest({ programId: "usr-abc123", target: { mainWorktree: true } })).toMatchObject({ target: { mainWorktree: true } });
  });

  it.each([
    ["an exe string next to valid ids", { programId: "vscode", target: { repoRoot: true }, exe: "C:\\x\\evil.exe" }],
    ["a folder string next to valid ids", { programId: "vscode", target: { repoRoot: true }, folder: "C:\\secret" }],
    ["a folder inside the target", { programId: "vscode", target: { repoRoot: true, folder: "C:\\x" } }],
    ["a path as program id", { programId: "C:\\x\\evil.exe", target: { repoRoot: true } }],
    ["a path as worktree id", { programId: "vscode", target: { worktreeId: "..\\..\\evil" } }],
    ["a slash in the worktree id", { programId: "vscode", target: { worktreeId: "a/b" } }],
    ["repoRoot false", { programId: "vscode", target: { repoRoot: false } }],
    ["no target", { programId: "vscode" }],
    ["an array", []],
    ["null", null],
    ["a string", "vscode"],
  ])("refuses %s", (_label, payload) => {
    expect(parseLaunchRequest(payload)).toMatchObject({ ok: false, reason: "invalid-request" });
  });
});

describe("launch authority (FR-642, AC6)", () => {
  it("refuses a renderer payload that carries an exe or folder string, and starts nothing", async () => {
    const s = setup({ picks: [CODE] });
    const added = await s.handlers.add();
    expect(added.status).toBe("added");
    const id = (added as { program: { id: string } }).program.id;
    const bad = await s.handlers.launch({ programId: id, target: { repoRoot: true }, exe: "C:\\x\\evil.exe" });
    expect(bad).toMatchObject({ ok: false, reason: "invalid-request" });
    expect(s.spawnFn).not.toHaveBeenCalled();
  });

  it("launches a registered worktree by id, resolved in main, and remembers the program as the default", async () => {
    const s = setup({ picks: [CODE] });
    const id = ((await s.handlers.add()) as { program: { id: string } }).program.id;
    const res = await s.handlers.launch({ programId: id, target: { worktreeId: "wt" } });
    expect(res).toMatchObject({ ok: true, wasDefault: false });
    expect(s.spawnFn).toHaveBeenCalledWith(CODE, ["C:\\work\\wt"], expect.objectContaining({ shell: false, cwd: HOME }));
    const snap = await s.handlers.list();
    expect(snap.defaultId).toBe(id);
    expect(await s.handlers.launch({ programId: id, target: { repoRoot: true } })).toMatchObject({ ok: true, wasDefault: true });
    expect(s.spawnFn).toHaveBeenLastCalledWith(CODE, ["C:\\work\\repo"], expect.anything());
  });

  it("refuses a worktree that is not registered/verified, with no process started", async () => {
    const s = setup({ picks: [CODE] });
    const id = ((await s.handlers.add()) as { program: { id: string } }).program.id;
    expect(await s.handlers.launch({ programId: id, target: { worktreeId: "ghost" } })).toMatchObject({ ok: false, reason: "folder-not-allowed" });
    expect(s.spawnFn).not.toHaveBeenCalled();
  });

  it("refuses a UNC folder even when the repository claims it", async () => {
    const s = setup({ picks: [CODE] });
    const id = ((await s.handlers.add()) as { program: { id: string } }).program.id;
    s.repo.verifyRegisteredWorktree = async (wid) => ({ trusted: true, id: wid, path: "\\\\host\\share\\wt", realPath: "\\\\host\\share\\wt" });
    expect(await s.handlers.launch({ programId: id, target: { worktreeId: "wt" } })).toMatchObject({ ok: false, reason: "folder-not-allowed" });
    s.repo.getState = () => ({ workdir: "\\\\?\\UNC\\host\\share\\repo", isBare: false });
    expect(await s.handlers.launch({ programId: id, target: { repoRoot: true } })).toMatchObject({ ok: false, reason: "folder-not-allowed" });
    expect(s.spawnFn).not.toHaveBeenCalled();
  });

  it("refuses repoRoot for a bare repository and reports no-repository when none is open", async () => {
    const s = setup({ picks: [CODE] });
    const id = ((await s.handlers.add()) as { program: { id: string } }).program.id;
    s.repo.getState = () => ({ workdir: null, isBare: true });
    expect(await s.handlers.launch({ programId: id, target: { repoRoot: true } })).toMatchObject({ ok: false, reason: "folder-not-allowed" });
    const closed = createProgramsHandlers(
      createProgramsService({ store: memoryStore(), env: makeEnv([]).env, home: HOME, spawnFn: vi.fn() as never, pickFile: async () => null }),
      () => {
        throw new Error("No repository is open");
      },
    );
    expect(await closed.launch({ programId: id, target: { repoRoot: true } })).toMatchObject({ ok: false, reason: "no-repository" });
  });

  it("re-runs the exe rules at launch: a program that vanished or became a script is not started", async () => {
    const s = setup({ picks: [CODE] });
    const id = ((await s.handlers.add()) as { program: { id: string } }).program.id;
    s.files.delete(CODE);
    expect(await s.handlers.launch({ programId: id, target: { repoRoot: true } })).toMatchObject({ ok: false, reason: "not-found" });
    expect(s.spawnFn).not.toHaveBeenCalled();
    // And the list shows it unavailable instead of dropping it (FR-623).
    const row = (await s.handlers.list()).programs.find((p) => p.id === id)!;
    expect(row).toMatchObject({ available: false, unavailableReason: `Not found at ${CODE}` });
  });

  it("returns a typed spawn-failed refusal with no retry and no path in the message", async () => {
    const failing = vi.fn(() => {
      throw new Error("spawn C:\\secret\\thing ENOENT");
    }) as unknown as SpawnFn;
    const s = setup({ picks: [CODE], spawn: failing });
    const id = ((await s.handlers.add()) as { program: { id: string } }).program.id;
    const res = await s.handlers.launch({ programId: id, target: { repoRoot: true } });
    expect(res).toMatchObject({ ok: false, reason: "spawn-failed" });
    expect(JSON.stringify(res)).not.toContain("secret");
    expect(failing).toHaveBeenCalledTimes(1);
  });
});

describe("Add / Locate / records (FR-623, FR-642)", () => {
  it("adds only through the main-side picker and applies the save-time rules", async () => {
    const s = setup({ files: [CODE, "C:\\x\\run.cmd", "C:\\x\\notes.txt"], picks: ["C:\\x\\run.cmd", "relative.exe", "C:\\x\\notes.txt", CODE, null] });
    expect(await s.handlers.add()).toMatchObject({ status: "rejected", problem: "script-extension" });
    expect(await s.handlers.add()).toMatchObject({ status: "rejected", problem: "relative" });
    expect(await s.handlers.add()).toMatchObject({ status: "rejected", problem: "not-windows-exe" });
    const added = await s.handlers.add();
    expect(added).toMatchObject({ status: "added", program: { name: "Code", source: "custom", path: CODE } });
    expect(await s.handlers.add()).toEqual({ status: "cancelled" });
    expect(await s.handlers.add()).toEqual({ status: "cancelled" });
  });

  it("refuses the same program twice", async () => {
    const s = setup({ picks: [CODE, CODE] });
    await s.handlers.add();
    expect(await s.handlers.add()).toMatchObject({ ok: false, reason: "already-added" });
  });

  it("a hand-added exe inside a repo needs a confirm with the full path; confirming saves it as confirmed, and it launches", async () => {
    const inRepo = "C:\\proj\\repo\\tools\\ed.exe";
    const s = setup({ files: [inRepo], repo: ["C:\\proj\\repo"], picks: [inRepo] });
    const res = await s.handlers.add();
    expect(res).toEqual({ status: "needs-confirm", pendingId: "pending-1", path: inRepo, why: "repository" });
    expect((await s.handlers.list()).programs).toHaveLength(0);
    const done = await s.handlers.confirmAdd("pending-1");
    expect(done).toMatchObject({ status: "added", program: { path: inRepo, available: true } });
    // The risk is re-checked at EVERY launch; the confirmed flag is what lets it through.
    const id = (done as { program: { id: string } }).program.id;
    expect(await s.handlers.launch({ programId: id, target: { repoRoot: true } })).toMatchObject({ ok: true });
  });

  it("a confirm token is single use and cannot be guessed", async () => {
    const inRepo = "C:\\proj\\repo\\tools\\ed.exe";
    const s = setup({ files: [inRepo], repo: ["C:\\proj\\repo"], picks: [inRepo] });
    await s.handlers.add();
    expect(await s.handlers.confirmAdd("wrong")).toMatchObject({ ok: false, reason: "confirm-expired" });
    expect(await s.handlers.confirmAdd("pending-1")).toMatchObject({ ok: false, reason: "confirm-expired" });
  });

  it("an unconfirmed program that ends up inside a repository is not started (rules re-run at launch)", async () => {
    const exe = "C:\\proj\\repo\\ed.exe";
    const s = setup({ files: [exe], repo: ["C:\\proj\\repo"], initial: { version: 1, defaultId: null, hidden: [], custom: [{ id: "usr-ed", name: "ed", exe }] } });
    expect(await s.handlers.launch({ programId: "usr-ed", target: { repoRoot: true } })).toMatchObject({ ok: false, reason: "unsafe-location" });
    expect(s.spawnFn).not.toHaveBeenCalled();
    expect((await s.handlers.list()).programs[0]).toMatchObject({ available: false });
  });

  it("Locate replaces the path of a missing hand-added program after the same checks", async () => {
    const s = setup({ files: [OTHER], picks: [OTHER], initial: { version: 1, defaultId: null, hidden: [], custom: [{ id: "usr-code", name: "Code", exe: CODE }] } });
    expect((await s.handlers.list()).programs[0]).toMatchObject({ available: false, unavailableReason: `Not found at ${CODE}` });
    const located = await s.handlers.locate("usr-code");
    expect(located).toMatchObject({ status: "added", program: { id: "usr-code", name: "Code", path: OTHER, available: true } });
  });

  it("Remove is for hand-added programs only; the default cannot be hidden; Hide/Show and Default persist", async () => {
    const s = setup({ picks: [CODE, OTHER] });
    const a = ((await s.handlers.add()) as { program: { id: string } }).program.id;
    const b = ((await s.handlers.add()) as { program: { id: string } }).program.id;
    expect(await s.handlers.setDefault(a)).toMatchObject({ ok: true });
    expect(await s.handlers.setHidden(a, true)).toMatchObject({ ok: false, reason: "default-cannot-hide" });
    expect(await s.handlers.setHidden(b, true)).toMatchObject({ ok: true });
    expect((await s.handlers.list()).programs.find((p) => p.id === b)?.hidden).toBe(true);
    expect(await s.handlers.setDefault(b)).toMatchObject({ ok: false, reason: "hidden" });
    expect(await s.handlers.setHidden(b, false)).toMatchObject({ ok: true });
    expect(await s.handlers.remove(a)).toMatchObject({ ok: true });
    expect((await s.handlers.list()).defaultId).toBeNull();
    expect(await s.handlers.setDefault("nope")).toMatchObject({ ok: false, reason: "unknown-program" });
    expect(await s.handlers.setDefault("C:\\x\\evil.exe")).toMatchObject({ ok: false, reason: "invalid-request" });
  });

  it("GitHydra tab is a valid stored default; a vanished default falls back to it with a stated reason", async () => {
    const s = setup({ picks: [CODE] });
    const id = ((await s.handlers.add()) as { program: { id: string } }).program.id;
    await s.handlers.setDefault(id);
    expect((await s.handlers.list()).defaultId).toBe(id);
    s.files.delete(CODE);
    const snap = await s.handlers.list();
    expect(snap.defaultId).toBe(GITHYDRA_TAB_ID);
    expect(snap.fallbackReason).toBe("Code was not found, so GitHydra tab is used instead.");
    await s.handlers.setDefault(GITHYDRA_TAB_ID);
    expect((await s.handlers.list()).fallbackReason).toBeNull();
  });
});

describe("program records file (FR-642)", () => {
  it("validates on read: bad ids, paths, duplicates and oversize lists are dropped, never thrown", () => {
    const r = validateRecords({
      version: 1,
      defaultId: "C:\\evil.exe",
      hidden: ["ok", "../bad", 5, "ok"],
      custom: [
        { id: "usr-1", name: "A", exe: "C:\\a.exe" },
        { id: "usr-1", name: "dup", exe: "C:\\b.exe" },
        { id: "bad id", name: "x", exe: "C:\\c.exe" },
        { id: "usr-2", name: "", exe: "C:\\c.exe" },
        { id: "usr-3", name: "x", exe: "C:\\c\0.exe" },
        ...Array.from({ length: 80 }, (_, i) => ({ id: `usr-n${i}`, name: "n", exe: "C:\\n.exe" })),
      ],
    });
    expect(r.defaultId).toBeNull();
    expect(r.hidden).toEqual(["ok"]);
    expect(r.custom.length).toBe(50);
    expect(r.custom[0]).toEqual({ id: "usr-1", name: "A", exe: "C:\\a.exe" });
    expect(validateRecords("garbage")).toEqual(emptyRecords());
  });

  it("writes atomically under its directory and survives a corrupt file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-programs-"));
    try {
      const store = createFileProgramStore(dir);
      expect(await store.read()).toEqual(emptyRecords());
      await store.write({ version: 1, defaultId: "vscode", hidden: ["zed"], custom: [{ id: "usr-1", name: "A", exe: "C:\\a.exe" }] });
      expect(await store.read()).toMatchObject({ defaultId: "vscode", hidden: ["zed"] });
      expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
      fs.writeFileSync(path.join(dir, "external-programs.json"), "{not json");
      expect(await store.read()).toEqual(emptyRecords());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("detected programs through the service (FR-621)", () => {
  it("hides a detected program but never removes it, and caches detection until Rescan", async () => {
    const { env } = makeEnv(["C:\\Program Files\\Microsoft VS Code\\Code.exe"]);
    const calls: string[] = [];
    env.runCommand = async (_c, args) => {
      calls.push(String(args[1]));
      return String(args[1]).startsWith("HKLM\\Software\\Microsoft")
        ? [
            "HKEY_X\\Uninstall\\{A}",
            "    DisplayName    REG_SZ    Microsoft Visual Studio Code",
            "    Publisher    REG_SZ    Microsoft Corporation",
            "    InstallLocation    REG_SZ    C:\\Program Files\\Microsoft VS Code",
          ].join("\r\n")
        : "";
    };
    const service = createProgramsService({ store: memoryStore(), env, home: HOME, spawnFn: vi.fn() as never, pickFile: async () => null });
    const h = createProgramsHandlers(service, () => ({}) as never);
    const first = await h.list();
    expect(first.programs.map((p) => [p.id, p.source])).toEqual([["vscode", "detected"]]);
    await h.list();
    expect(calls.length).toBe(3);
    expect(await h.remove("vscode")).toMatchObject({ ok: false, reason: "invalid-request" });
    expect(await h.setHidden("vscode", true)).toMatchObject({ ok: true });
    await h.rescan();
    expect(calls.length).toBe(6);
    expect((await h.list()).programs[0]).toMatchObject({ id: "vscode", hidden: true });
  });
});

describe("test-only spawn recorder (AC9)", () => {
  it("is honoured only when unpackaged AND an absolute path is named", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-rec-"));
    try {
      const file = path.join(dir, "spawns.jsonl");
      const recorded = chooseSpawnFn({ isPackaged: false, env: { [E2E_SPAWN_RECORD_ENV]: file } });
      recorded("C:\\Tools\\Code.exe", ["C:\\work\\wt"], { shell: false, detached: true, stdio: "ignore", cwd: "C:\\h", env: { ELECTRON_RUN_AS_NODE: "1", OK: "1" } });
      const line = JSON.parse(fs.readFileSync(file, "utf8").trim());
      expect(line).toMatchObject({ command: "C:\\Tools\\Code.exe", args: ["C:\\work\\wt"], shell: false, detached: true, stdio: "ignore", cwd: "C:\\h", droppedKeysPresent: ["ELECTRON_RUN_AS_NODE"] });
      // Packaged, or a relative path: the real spawn is chosen (it would start a process, so only its identity is checked).
      expect(chooseSpawnFn({ isPackaged: true, env: { [E2E_SPAWN_RECORD_ENV]: file } })).not.toBe(recorded);
      fs.unlinkSync(file);
      const rel = chooseSpawnFn({ isPackaged: false, env: { [E2E_SPAWN_RECORD_ENV]: "spawns.jsonl" } });
      expect(fs.existsSync(file)).toBe(false);
      expect(typeof rel).toBe("function");
      void createSpawnRecorder;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
