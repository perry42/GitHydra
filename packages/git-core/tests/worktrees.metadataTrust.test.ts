// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { listWorktrees } from "../src/worktreeList";
import { verifyRegisteredWorktree, verifyWorktreeMetadata } from "../src/worktreePaths";
import { getWorktreeRemovalState, removeWorktree } from "../src/worktrees";
import { _setWorktreeGitVersionForTests, _setWorktreeRunnerForTests } from "../src/worktreeRunner";
import { classifyPathString } from "../src/worktreeParse";
import { runGit, runGitAllowingExitCodes } from "../src/gitProcess";
import { git, cleanup, makeRepoInTempParent, fileExists, initRepo } from "./testRepo";
import { porcelainToNul, recordingRunner, type RecordedCall } from "./worktreeKit";

/**
 * specs/worktrees.md AC10 (forged `gitdir`, run for real on the machine's own git), AC11 (FR-640/FR-641 fixtures).
 * `<common-dir>/worktrees/<id>/gitdir` is repo-controlled, so none of these entries may ever become openable or removable.
 */
const dirs: string[] = [];
beforeEach(() => {
  _setWorktreeGitVersionForTests(undefined);
  _setWorktreeRunnerForTests(null);
});
afterEach(async () => {
  _setWorktreeGitVersionForTests(undefined);
  _setWorktreeRunnerForTests(null);
  while (dirs.length) await cleanup(dirs.pop()!);
});

async function victimFixture() {
  const { parent, repo } = await makeRepoInTempParent();
  dirs.push(parent);
  const victimDir = path.join(parent, "victim");
  await git(repo, ["worktree", "add", "-q", victimDir, "-b", "victim"]);
  const sha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  const gitdirFile = path.join(repo, ".git", "worktrees", "victim", "gitdir");
  const honest = (await fs.readFile(gitdirFile, "utf8")).replace(/\r?\n$/, "");
  return { parent, repo, victimDir, sha, gitdirFile, honest };
}

// git >= 2.36 takes the `-z` path, older git the newline path. Both formats are driven deliberately: the version stub picks
// the format on whatever git is installed (a stubbed-old version makes the code ask for the newline porcelain, which every
// git still prints, forged rows included).
const FORMATS = [
  ["newline", { major: 2, minor: 35, patch: 0 }],
  ["nul", { major: 2, minor: 40, patch: 0 }],
] as const;

/** `-z` is simulated from the newline output so the nul parser is fed identical text on every git, old ones included. */
function nulFromNewlineRunner(mutate: (out: string) => string = (o) => o) {
  return recordingRunner((args) =>
    args.includes("list") && args.includes("-z") ? { args: args.filter((a) => a !== "-z"), stdout: (real) => porcelainToNul(mutate(real)) } : args.includes("list") ? { stdout: (real) => mutate(real) } : undefined,
  );
}

describe("forged gitdir (AC10, FR-601)", () => {
  // The spec's literal payload has no `/.git` suffix; the second variant keeps one so every git version strips it.
  describe.each(FORMATS)("%s format", (format, version) => {
    it.each([
      ["no suffix", (honest: string, sha: string) => `${honest}\nHEAD ${sha}\n\nworktree /evil\n`],
      ["with suffix", (honest: string, sha: string) => `${honest}\nHEAD ${sha}\n\nworktree /evil/.git\n`],
      ["CRLF", (honest: string, sha: string) => `${honest}\r\nHEAD ${sha}\r\n\r\nworktree /evil/.git\r\n`],
    ])("real git, %s: exactly one supported:false entry and NO /evil row", async (_name, forge) => {
      const f = await victimFixture();
      await fs.writeFile(f.gitdirFile, forge(f.honest, f.sha));
      _setWorktreeGitVersionForTests(version);
      const list = await listWorktrees(f.repo);
      expect(list.entries.filter((e) => !e.supported)).toHaveLength(1);
      expect(list.entries.some((e) => /evil/.test(e.path))).toBe(false);
      expect(list.entries).toHaveLength(2);
      expect(list.entries[1]!.id).toBe("victim");
      if (list.format === "newline") {
        // Forged rows are visible in the newline porcelain, so the block count disagrees with the admin dirs.
        expect(list.untrusted).toBe(true);
      } else {
        // -z (git >= 2.36) delimits an embedded newline faithfully: the entry is unsupported and no row is forged, so the
        // list may stay trusted (specs/worktrees.md FR-601 wording: "untrusted" is for a disagreement git's blocks show).
        expect(format).toBe("nul");
        expect(list.untrusted).toBe(false);
      }
    });
  });

  it("the unforged baseline is trusted", async () => {
    const f = await victimFixture();
    const list = await listWorktrees(f.repo);
    expect(list.untrusted).toBe(false);
    expect(list.entries.every((e) => e.supported)).toBe(true);
  });

  it("on this machine's own git the forgery is live in the newline porcelain and faithfully delimited under -z", async () => {
    const f = await victimFixture();
    await fs.writeFile(f.gitdirFile, `${f.honest}\nHEAD ${f.sha}\n\nworktree /evil/.git\n`);
    const raw = (await git(f.repo, ["worktree", "list", "--porcelain"])).stdout;
    // Proves the attack is live in the newline format on every git, so the assertions above are not vacuous.
    expect(raw.split("\n").some((l) => l.trimEnd() === "worktree /evil")).toBe(true);
    const z = await git(f.repo, ["worktree", "list", "--porcelain", "-z"]).catch(() => null);
    if (z) expect(z.stdout.split("\0").some((field) => field === "worktree /evil")).toBe(false);
  });

  it("with the machine's real -z output (git >= 2.36) a forged newline path is one unsupported entry, no /evil row, list trusted", async (ctx) => {
    const f = await victimFixture();
    const v = /(?:git version )(\d+)\.(\d+)/.exec((await git(f.repo, ["--version"])).stdout);
    if (!v || Number(v[1]) < 2 || (Number(v[1]) === 2 && Number(v[2]) < 36)) return ctx.skip();
    await fs.writeFile(f.gitdirFile, `${f.honest}\nHEAD ${f.sha}\n\nworktree /evil/.git\n`);
    const list = await listWorktrees(f.repo);
    expect(list.format).toBe("nul");
    expect(list.entries).toHaveLength(2);
    expect(list.entries[1]).toMatchObject({ id: "victim", supported: false });
    expect(list.entries.some((e) => /evil/.test(e.path))).toBe(false);
    expect(list.untrusted).toBe(false);
  });

  it.each(FORMATS)("an untrusted list (%s) disables verification and removal for every linked entry", async (_f, version) => {
    const f = await victimFixture();
    await fs.writeFile(f.gitdirFile, `${f.honest}\nHEAD ${f.sha}\n\nworktree /evil\n`);
    _setWorktreeGitVersionForTests(version);
    // The nul format keeps a forged-newline list trusted, so make git's blocks disagree with the admin dirs.
    const { runner } = nulFromNewlineRunner((out) => `${out}worktree /ghost\nHEAD ${"a".repeat(40)}\ndetached\n\n`);
    _setWorktreeRunnerForTests(runner);
    await expect(verifyRegisteredWorktree(f.repo, "victim")).resolves.toEqual({ trusted: false, reason: "untrusted-list" });
    const res = await removeWorktree(f.repo, "victim", { confirmedPath: f.victimDir });
    expect(res).toMatchObject({ ok: false, reason: "unsupported" });
    expect(await fileExists(path.join(f.victimDir, ".git"))).toBe(true);
  });

  describe.each(FORMATS)("porcelain that does not match the admin dirs (%s)", (_format, version) => {
    it.each([
      ["extra block", (out: string) => `${out}worktree /ghost\nHEAD ${"a".repeat(40)}\ndetached\n\n`, "count-mismatch"],
      ["different path", (out: string) => out.replace(/worktree ([^\n]*victim)\n/, "worktree $1-moved\n"), "path-mismatch"],
      ["unknown line", (out: string) => out.replace(/(branch refs\/heads\/victim\n)/, "$1surprise line\n"), "malformed-output"],
      ["duplicate key", (out: string) => out.replace(/(HEAD [0-9a-f]+\n)/, "$1$1"), "malformed-output"],
      ["wrong order", (out: string) => out.replace(/(worktree [^\n]*\n)(HEAD [^\n]*\n)/, "$2$1"), "malformed-output"],
    ])("%s marks the whole list untrusted", async (_n, mutate, reason) => {
      const f = await victimFixture();
      _setWorktreeGitVersionForTests(version);
      _setWorktreeRunnerForTests(nulFromNewlineRunner(mutate).runner);
      const list = await listWorktrees(f.repo);
      expect(list.untrusted).toBe(true);
      expect(list.untrustedReason).toBe(reason);
      expect(list.entries[0]!.isMain).toBe(true);
      expect(list.entries.some((e) => e.path === "/ghost")).toBe(false);
    });
  });
});

describe("-z path for git >= 2.36 (version-stubbed on this git)", () => {
  it("uses `worktree list --porcelain -z` and yields the same entries as the newline format", async () => {
    const f = await victimFixture();
    const newline = await listWorktrees(f.repo);

    _setWorktreeGitVersionForTests({ major: 2, minor: 40, patch: 0 });
    const { runner, calls } = recordingRunner((args) =>
      args.includes("-z") ? { args: args.filter((a) => a !== "-z"), stdout: porcelainToNul } : undefined,
    );
    _setWorktreeRunnerForTests(runner);
    const nul = await listWorktrees(f.repo);

    expect(calls.some((c) => c.args.includes("-z"))).toBe(true);
    expect(nul.format).toBe("nul");
    expect(nul.untrusted).toBe(false);
    expect(nul.entries).toEqual(newline.entries);
  });

  it("a path with a line break stays one field under -z: unsupported, but not a forged row and the list stays trusted", async () => {
    const f = await victimFixture();
    const forgedPath = `${f.honest.replace(/\/\.git$/, "")}\nHEAD ${f.sha}\n\nworktree /evil`;
    const before = (await git(f.repo, ["worktree", "list", "--porcelain"])).stdout;
    await fs.writeFile(f.gitdirFile, `${forgedPath}/.git\n`);

    _setWorktreeGitVersionForTests({ major: 2, minor: 40, patch: 0 });
    const honestPath = f.honest.replace(/\/\.git$/, "");
    const { runner } = recordingRunner((args) =>
      args.includes("-z")
        ? { args: args.filter((a) => a !== "-z"), stdout: () => porcelainToNul(before).replace(`worktree ${honestPath}\0`, `worktree ${forgedPath}\0`) }
        : undefined,
    );
    _setWorktreeRunnerForTests(runner);
    const list = await listWorktrees(f.repo);
    expect(list.format).toBe("nul");
    expect(list.entries).toHaveLength(2);
    expect(list.entries[1]).toMatchObject({ id: "victim", supported: false });
    expect(list.entries.some((e) => /evil/.test(e.path))).toBe(false);
    expect(list.untrusted).toBe(false);
  });

  it("falls back to the newline format when a wrongly-guessed version makes git reject -z", async () => {
    const f = await victimFixture();
    _setWorktreeGitVersionForTests({ major: 2, minor: 40, patch: 0 });
    // Real git 2.31 rejects the switch ("unknown switch `z'"); newer gits would accept it and this still holds.
    const list = await listWorktrees(f.repo);
    expect(list.entries).toHaveLength(2);
    expect(list.untrusted).toBe(false);
  });

  it("git before 2.31 prints no prunable/lock-reason lines: both come read-only from the admin dir", async () => {
    const { parent, repo } = await makeRepoInTempParent();
    dirs.push(parent);
    await git(repo, ["worktree", "add", "-q", path.join(parent, "gone"), "-b", "gone"]);
    await git(repo, ["worktree", "add", "-q", path.join(parent, "kept"), "-b", "kept"]);
    await git(repo, ["worktree", "lock", "--reason", "because", path.join(parent, "kept")]);
    await fs.rm(path.join(parent, "gone"), { recursive: true, force: true });

    _setWorktreeGitVersionForTests({ major: 2, minor: 30, patch: 1 });
    const { runner } = recordingRunner((args) =>
      args.includes("list") ? { stdout: (real) => real.replace(/^prunable.*\n/gm, "").replace(/^locked .*$/gm, "locked") } : undefined,
    );
    _setWorktreeRunnerForTests(runner);
    const list = await listWorktrees(repo);
    expect(list.untrusted).toBe(false);
    expect(list.entries.find((e) => e.id === "gone")).toMatchObject({ prunable: true });
    expect(list.entries.find((e) => e.id === "kept")).toMatchObject({ locked: true, lockReason: "because", prunable: false });
  });
});

describe("FR-640 / FR-641 refusal fixtures (AC11)", () => {
  it("an honest worktree verifies", async () => {
    const f = await victimFixture();
    const v = await verifyRegisteredWorktree(f.repo, "victim");
    expect(v).toMatchObject({ trusted: true, id: "victim" });
  });

  it("a forged gitdir pointing at an unrelated repository is 'not a worktree' and cannot be inspected or removed", async () => {
    const f = await victimFixture();
    const unrelated = await initRepo();
    dirs.push(unrelated);
    await fs.writeFile(path.join(unrelated, "precious.txt"), "do not touch\n");
    await fs.writeFile(f.gitdirFile, `${unrelated.replace(/\\/g, "/")}/.git\n`);

    const list = await listWorktrees(f.repo);
    expect(list.untrusted).toBe(false); // git itself agrees with the forged file; only FR-640 can catch it
    const v = await verifyRegisteredWorktree(f.repo, "victim", { list });
    expect(v.trusted).toBe(false);
    expect(await getWorktreeRemovalState(f.repo, "victim")).toMatchObject({ ok: false });

    const { runner, calls } = recordingRunner();
    _setWorktreeRunnerForTests(runner);
    const res = await removeWorktree(f.repo, "victim", { confirmedPath: list.entries[1]!.path });
    expect(res).toMatchObject({ ok: false, reason: "notAWorktree" });
    expect(calls.some((c) => c.args.includes("remove"))).toBe(false);
    expect(await fileExists(path.join(unrelated, "precious.txt"))).toBe(true);
  });

  it("a folder whose .git file points back at a different admin dir fails the back-link check", async () => {
    const f = await victimFixture();
    const other = path.join(f.parent, "other");
    await git(f.repo, ["worktree", "add", "-q", other, "-b", "other"]);
    // victim's admin dir now claims a decoy folder whose .git file names the `other` admin dir, not victim's.
    const decoy = path.join(f.parent, "decoy");
    await fs.mkdir(decoy);
    await fs.writeFile(path.join(decoy, ".git"), `gitdir: ${path.join(f.repo, ".git", "worktrees", "other").replace(/\\/g, "/")}\n`);
    await fs.writeFile(f.gitdirFile, `${path.join(decoy, ".git").replace(/\\/g, "/")}\n`);
    const list = await listWorktrees(f.repo);
    expect(list.untrusted).toBe(false);
    expect(await verifyRegisteredWorktree(f.repo, "victim", { list })).toEqual({ trusted: false, reason: "backlink-mismatch" });
  });

  it("a .git file over 4 KB or not exactly `gitdir: <p>` is rejected", async () => {
    const f = await victimFixture();
    const gitFile = path.join(f.victimDir, ".git");
    const honest = await fs.readFile(gitFile, "utf8");
    // The file carries the hidden attribute on Windows, which makes an in-place write fail with EPERM.
    const rewrite = async (text: string) => {
      await fs.rm(gitFile, { force: true });
      await fs.writeFile(gitFile, text);
    };
    await rewrite(`${honest.trimEnd()}\n${"x".repeat(5000)}`);
    expect(await verifyRegisteredWorktree(f.repo, "victim")).toEqual({ trusted: false, reason: "bad-gitfile" });
    await rewrite(`${honest.trimEnd()}\nextra line\n`);
    expect(await verifyRegisteredWorktree(f.repo, "victim")).toEqual({ trusted: false, reason: "bad-gitfile" });
    await rewrite("not a gitfile\n");
    expect(await verifyRegisteredWorktree(f.repo, "victim")).toEqual({ trusted: false, reason: "bad-gitfile" });
  });

  it("a worktree whose .git is a directory (a nested repo) is rejected", async () => {
    const f = await victimFixture();
    await fs.rm(path.join(f.victimDir, ".git"), { force: true });
    await git(f.victimDir, ["init", "-q"]);
    expect(await verifyRegisteredWorktree(f.repo, "victim")).toEqual({ trusted: false, reason: "not-a-gitfile" });
  });

  it("a registered worktree nested inside the main working tree verifies and is removable when its back-link is valid", async () => {
    const { parent, repo } = await makeRepoInTempParent();
    dirs.push(parent);
    await fs.writeFile(path.join(repo, ".gitignore"), ".worktrees/\n");
    await git(repo, ["add", ".gitignore"]);
    await git(repo, ["commit", "-q", "-m", "ignore nested"]);
    const nested = path.join(repo, ".worktrees", "nested-wt");
    await git(repo, ["worktree", "add", "-q", nested, "-b", "nested"]);
    const list = await listWorktrees(repo);
    const id = list.entries[1]!.id!;
    expect(await verifyRegisteredWorktree(repo, id)).toMatchObject({ trusted: true, id });
    expect(await getWorktreeRemovalState(repo, id)).toMatchObject({ ok: true, count: 0 });
    expect(await removeWorktree(repo, id, { confirmedPath: list.entries[1]!.path })).toMatchObject({ ok: true });
    expect(await fileExists(nested)).toBe(false);
  });

  it("a nested path with a FORGED back-link is still refused", async () => {
    const { parent, repo } = await makeRepoInTempParent();
    dirs.push(parent);
    const real = path.join(parent, "real");
    await git(repo, ["worktree", "add", "-q", real, "-b", "real"]);
    const id = (await listWorktrees(repo)).entries[1]!.id!;
    // Planted folder inside the repo whose .git file names a different admin dir than the one claiming it.
    const planted = path.join(repo, "planted");
    await fs.mkdir(planted);
    await fs.writeFile(path.join(planted, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "somewhere-else").replace(/\\/g, "/")}\n`);
    await fs.writeFile(path.join(repo, ".git", "worktrees", id, "gitdir"), `${path.join(planted, ".git").replace(/\\/g, "/")}\n`);
    expect(await verifyRegisteredWorktree(repo, id)).toEqual({ trusted: false, reason: "backlink-mismatch" });
    const entry = (await listWorktrees(repo)).entries[1]!;
    expect(await removeWorktree(repo, id, { confirmedPath: entry.path })).toMatchObject({ ok: false, reason: "notAWorktree" });
    expect(await fileExists(planted)).toBe(true);
  });

  it("a missing folder reports 'missing', not a crash", async () => {
    const f = await victimFixture();
    await fs.rm(f.victimDir, { recursive: true, force: true });
    expect(await verifyRegisteredWorktree(f.repo, "victim")).toEqual({ trusted: false, reason: "missing" });
  });

  it("string-level rejections run before any filesystem access", async () => {
    const f = await victimFixture();
    const base = { commonDir: path.join(f.repo, ".git"), mainPath: f.repo, mainIsBare: false, id: "victim" };
    const started = Date.now();
    for (const [p, reason] of [
      ["\\\\server\\share\\wt", "unc"],
      ["//server/share/wt", "unc"],
      ["\\\\?\\UNC\\server\\share\\wt", "unc"],
      ["\\\\.\\COM1", "unc"],
      ["C:\\work\\NUL", "reserved-name"],
      ["C:\\work\\com1.txt", "reserved-name"],
      ["relative/path", "invalid-path"],
      ["", "invalid-path"],
      ["C:\\work\\line\nbreak", "invalid-path"],
    ] as const) {
      expect(await verifyWorktreeMetadata({ ...base, worktreePath: p, platform: "win32" }), p).toEqual({ trusted: false, reason });
    }
    expect(Date.now() - started).toBeLessThan(2000); // a probed UNC host would stall on a network timeout
  });

  it("classifyPathString covers the spec's UNC and device forms on any platform", () => {
    for (const p of ["\\\\server\\s", "//server/s", "\\\\?\\C:\\x", "\\\\.\\pipe\\x"]) expect(classifyPathString(p, "win32"), p).toBe("unc");
    expect(classifyPathString("C:\\ok\\dir", "win32")).toBeNull();
    expect(classifyPathString("/home/aux/proj", "linux")).toBeNull();
    expect(classifyPathString("/home/me/nul", "linux")).toBe("reservedName");
    expect(classifyPathString("C:foo", "win32")).toBe("notAbsolute");
  });
});
