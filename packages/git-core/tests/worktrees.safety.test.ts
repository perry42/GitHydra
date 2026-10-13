// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterAll, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { _safeEnvForTests } from "../src/gitProcess";
import { WorktreeOperationError } from "../src/errors";
import { listWorktrees } from "../src/worktreeList";
import { detectPostCheckoutHook } from "../src/worktreeHook";
import { validateWorktreeDestination, verifyRegisteredWorktree } from "../src/worktreePaths";
import {
  addWorktree,
  getBranchMergeState,
  getWorktreeRemovalState,
  pruneWorktree,
  removeWorktree,
  removeWorktreeAndDeleteBranch,
} from "../src/worktrees";
import { _setWorktreeGitVersionForTests, _setWorktreeRunnerForTests } from "../src/worktreeRunner";
import { cleanup, commit, git, leakedWorktreeFolders, makeRepoInTempParent, writeFile } from "./testRepo";
import { recordingRunner, type RecordedCall } from "./worktreeKit";

/** specs/worktrees.md AC2 (argv spy + source grep), the security checklist items 1 and 6, and the temp-folder leak guard. */
const dirs: string[] = [];
beforeEach(() => {
  _setWorktreeGitVersionForTests(undefined);
  _setWorktreeRunnerForTests(null);
});
afterEach(async () => {
  _setWorktreeRunnerForTests(null);
  while (dirs.length) await cleanup(dirs.pop()!);
});
afterAll(async () => {
  // Fixtures live inside a unique temp parent; a `*.worktrees` folder next to a temp repo means a test leaked one.
  expect(await leakedWorktreeFolders()).toEqual([]);
});

/** Runs every public worktree function on success and failure paths and returns the recorded argv of all of them. */
async function exerciseEverything(): Promise<{ calls: RecordedCall[]; forceRemoves: number; errors: unknown[] }> {
  const { parent, repo, worktreesDir } = await makeRepoInTempParent();
  dirs.push(parent);
  for (const b of ["b1", "b2", "b3", "b4", "b5"]) await git(repo, ["branch", b]);
  // The spy redirects one add at an existing file so git itself fails after creating the branch (rollback + typed error).
  const { runner, calls } = recordingRunner((args) => {
    if (!args.includes("rb-fail") || !args.includes("add")) return undefined;
    const swapped = [...args];
    swapped[swapped.indexOf("--") + 1] = path.join(repo, "a.txt");
    return { args: swapped };
  });
  _setWorktreeRunnerForTests(runner);
  const errors: unknown[] = [];
  const attempt = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      errors.push(err);
    }
  };

  await attempt(() => listWorktrees(repo));
  await attempt(() => detectPostCheckoutHook(repo));
  await attempt(() => getBranchMergeState(repo, "b1"));
  await attempt(() => validateWorktreeDestination(repo, path.join(worktreesDir, "v")));

  const w = (n: string) => path.join(worktreesDir, n);
  await attempt(() => addWorktree(repo, w("b1"), { kind: "branch", branch: "b1" }));
  const hookFile = path.join(repo, ".git", "hooks", "post-checkout");
  await fsp.mkdir(path.dirname(hookFile), { recursive: true });
  await fsp.writeFile(hookFile, "#!/bin/sh\nexit 0\n");
  const shown = await detectPostCheckoutHook(repo);
  await attempt(() => addWorktree(repo, w("b2"), { kind: "branch", branch: "b2" }, { runPostCheckoutHook: true, expectedHookFingerprint: shown.present ? shown.fingerprint : "" }));
  await attempt(() => addWorktree(repo, w("b3"), { kind: "newBranch", branch: "n3", startPoint: "HEAD" }));
  await attempt(() => addWorktree(repo, w("det"), { kind: "detached", commit: "HEAD" }));
  await attempt(() => addWorktree(repo, w("b1"), { kind: "branch", branch: "b4" })); // refused: folder is a worktree
  await attempt(() => addWorktree(repo, w("b1"), { kind: "branch", branch: "zzz" })); // refused: unknown branch
  await attempt(() => addWorktree(repo, w("rb-fail"), { kind: "newBranch", branch: "rb-fail", startPoint: "HEAD" }));

  const list = await listWorktrees(repo);
  const id = (branch: string) => list.entries.find((e) => e.branch === branch)!.id!;
  const pathOf = (branch: string) => list.entries.find((e) => e.branch === branch)!.path;

  await attempt(() => verifyRegisteredWorktree(repo, id("b1")));
  await attempt(() => getWorktreeRemovalState(repo, id("b1")));

  await writeFile(pathOf("b2"), "dirty.txt", "x");
  await attempt(() => removeWorktree(repo, id("b2"), { confirmedPath: pathOf("b2") })); // refused: dirty
  await attempt(() => removeWorktree(repo, id("b2"), { confirmedPath: pathOf("b2"), force: true })); // the single allowed force
  await attempt(() => removeWorktree(repo, id("b1"), { confirmedPath: pathOf("b1") }));
  await attempt(() => removeWorktree(repo, null, { confirmedPath: repo }));
  await attempt(() => removeWorktreeAndDeleteBranch(repo, id("n3"), { confirmedPath: pathOf("n3") }));

  await git(repo, ["worktree", "add", "-q", w("p1"), "-b", "p1"]);
  await git(repo, ["worktree", "add", "-q", w("p2"), "-b", "p2"]);
  await fsp.rm(w("p1"), { recursive: true, force: true });
  await fsp.rm(w("p2"), { recursive: true, force: true });
  await attempt(() => pruneWorktree(repo, "p1"));
  await attempt(() => pruneWorktree(repo, "p1", { acceptAlsoForgotten: ["p2"] }));

  await attempt(() => getBranchMergeState(repo, "b4"));
  await writeFile(repo, "late.txt", "x");
  await commit(repo, "late");
  const forceRemoves = calls.filter((c) => c.args.includes("--force")).length;
  return { calls, forceRemoves, errors };
}

const carriesHooks = (c: RecordedCall): boolean => c.args.some((a) => a.startsWith("core.hooksPath="));

describe("runner spy over every public function (AC2)", () => {
  it("never passes a force flag except the single allow-listed dirty remove; never -D, -B, -f or --no-verify", async () => {
    const { calls, forceRemoves } = await exerciseEverything();
    expect(calls.length).toBeGreaterThan(40);
    expect(forceRemoves).toBe(1);
    for (const c of calls) {
      for (const bad of ["-f", "-D", "-B", "--no-verify", "--force-with-lease", "-ff"]) expect(c.args, c.args.join(" ")).not.toContain(bad);
      const forces = c.args.filter((a) => a === "--force");
      if (forces.length) {
        expect(forces).toHaveLength(1); // never doubled: a second one is how git removes a locked worktree
        expect(c.args).toContain("remove");
      }
    }
    expect(calls.some((c) => c.args.includes("branch") && c.args.includes("-d"))).toBe(true);
  });

  it("every call neutralises core.fsmonitor and inherits safeEnv (LC_ALL=C, literal pathspecs) unmodified", async () => {
    const env = _safeEnvForTests();
    expect(env.LC_ALL).toBe("C");
    expect(env.GIT_LITERAL_PATHSPECS).toBe("1");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");

    const { calls } = await exerciseEverything();
    for (const c of calls) {
      expect(c.args.slice(0, 2), c.args.join(" ")).toEqual(["-c", "core.fsmonitor=false"]);
      expect(c.opts.extraEnv?.LC_ALL).toBeUndefined();
      expect(c.opts.extraEnv?.GIT_LITERAL_PATHSPECS).toBeUndefined();
      expect(c.opts.cwd).toBeTruthy();
    }
  });

  it("hooks are only overridden on `worktree add`, `update-ref -d` and `branch -d`; `--` precedes the absolute add path; safe.directory is never set", async () => {
    const { calls } = await exerciseEverything();
    for (const c of calls) {
      const hasHooks = c.args.some((a) => a.startsWith("core.hooksPath="));
      if (hasHooks) {
        const verb = c.args.find((a, i) => i > 1 && !a.startsWith("-") && c.args[i - 1] !== "-c")!;
        expect(["worktree", "update-ref", "branch"]).toContain(verb);
      }
      expect(c.args.some((a) => /safe\.directory/.test(a))).toBe(false);
      if (c.args.includes("add") && c.args.includes("worktree")) {
        const term = c.args.indexOf("--");
        expect(term).toBeGreaterThan(-1);
        expect(path.isAbsolute(c.args[term + 1]!)).toBe(true);
        expect(carriesHooks(c)).toBe(true); // an empty dir, or the private copy of the one consented hook
      }
      if (c.args.includes("update-ref") || (c.args.includes("branch") && c.args.includes("-d"))) expect(carriesHooks(c)).toBe(true);
    }
  });

  it("failures are typed and redacted: no stderr, no -c values, no private hooks dir", async () => {
    const { errors } = await exerciseEverything();
    const typed = errors.filter((e): e is WorktreeOperationError => e instanceof WorktreeOperationError);
    expect(typed.length).toBeGreaterThan(0);
    for (const e of typed) {
      const text = `${e.message} ${JSON.stringify(e)}`;
      expect(text).not.toMatch(/fatal:|core\.|githydra-nohooks|-c /);
      expect(["git-failed", "unexpected-output", "dubious-ownership", "not-a-repository"]).toContain(e.reason);
    }
    expect(errors.every((e) => e instanceof WorktreeOperationError)).toBe(true);
  });
});

describe("source guard over the worktree modules (security checklist 6)", () => {
  const SRC = path.resolve(__dirname, "..", "src");
  const files = fs
    .readdirSync(SRC)
    .filter((n) => (/^worktree.*\.ts$/.test(n) && n !== "worktreeWatcher.ts") || n === "gitVersion.ts" || n === "emptyHooksDir.ts");
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const source = (n: string) => stripComments(fs.readFileSync(path.join(SRC, n), "utf8"));

  it("covers the expected modules", () => {
    expect(files).toEqual(expect.arrayContaining(["worktrees.ts", "worktreeList.ts", "worktreePaths.ts", "worktreeParse.ts", "worktreeRunner.ts", "worktreeHook.ts"]));
  });

  it("no exec, no shell:true, no direct child_process in any of them", () => {
    for (const n of files) {
      const text = source(n);
      expect(text, n).not.toMatch(/child_process/);
      expect(text, n).not.toMatch(/(?<![.\w])exec(Sync|File|FileSync)?\s*\(/);
      expect(text, n).not.toMatch(/\bspawn(Sync)?\s*\(/);
      expect(text, n).not.toMatch(/shell\s*:\s*true/);
    }
  });

  it("the force flag, -f, -D and -B appear in the source only as the single allow-listed remove", () => {
    let forceHits = 0;
    for (const n of files) {
      const text = source(n);
      expect(text, n).not.toMatch(/["'`]-f["'`]/);
      expect(text, n).not.toMatch(/["'`]-D["'`]/);
      expect(text, n).not.toMatch(/["'`]-B["'`]/);
      expect(text, n).not.toMatch(/--no-verify/);
      const hits = text.match(/["'`]--force["'`]/g)?.length ?? 0;
      forceHits += hits;
      if (hits > 0) {
        expect(n).toBe("worktrees.ts");
        const body = text.slice(text.indexOf("async function removeCore("));
        const end = body.indexOf("\n}\n");
        expect(body.slice(0, end)).toMatch(/\[\s*"--force"\s*\]/);
      }
    }
    expect(forceHits).toBe(1);
  });

  it("every git argv goes through the runner seam, which prepends the fsmonitor override", () => {
    const runner = source("worktreeRunner.ts");
    expect(runner).toMatch(/withFsmonitorNeutralized\(args\)/);
    for (const n of files.filter((f) => f !== "worktreeRunner.ts")) {
      expect(source(n), n).not.toMatch(/\brunGit(AllowingExitCodes|Buffer|WithInput)?\s*\(/);
    }
  });
});
