// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getCombinedFileDiff, toggleCombinedLines, readWorktreeBounded, _setCombinedMidReadHookForTests } from "../src/combinedStaging";
import { _getSpawnCountForTests, runGitWithInput } from "../src/gitProcess";
import { GitCommandError, StaleDiffError } from "../src/errors";
import { git, initRepo, writeFile, commit, cleanup } from "./testRepo";

const dirs: string[] = [];
afterEach(async () => {
  _setCombinedMidReadHookForTests(null);
  while (dirs.length) await cleanup(dirs.pop()!);
});

async function fixture(): Promise<string> {
  const dir = await initRepo();
  dirs.push(dir);
  await git(dir, ["config", "core.autocrlf", "false"]);
  await writeFile(dir, "f.txt", "a\nb\nc\n");
  await commit(dir, "base");
  await writeFile(dir, "f.txt", "a\nB\nc\n");
  return dir;
}

describe("single-attempt mutation snapshots (FR-479/480 security review)", () => {
  it("a mutation whose file changes mid-read fails with StaleDiffError after ONE attempt; a read retries", async () => {
    const dir = await fixture();
    const d = await getCombinedFileDiff(dir, "f.txt");
    if (d.mode !== "combined") throw new Error("expected combined");
    const idx = d.hunks[0]!.lines.findIndex((l) => l.type === "add");

    let calls = 0;
    let unique = 0;
    _setCombinedMidReadHookForTests(async () => {
      calls++;
      await writeFile(dir, "f.txt", `a\nB\nc\n${"x".repeat(++unique)}\n`);
    });
    const before = _getSpawnCountForTests();
    await expect(toggleCombinedLines(dir, "f.txt", d.fingerprint, [{ hunkIndex: 0, lineIndex: idx }], "stage")).rejects.toBeInstanceOf(StaleDiffError);
    expect(calls).toBe(1);
    expect(_getSpawnCountForTests() - before).toBeLessThan(10);
    expect((await git(dir, ["diff", "--cached", "--name-only"])).stdout.trim()).toBe("");

    calls = 0;
    await getCombinedFileDiff(dir, "f.txt"); // unstable every time: retries up to 3 times, then separate
    expect(calls).toBe(3);
  });
});

describe("GitCommandError hides -c option pairs", () => {
  it("strips core.hooksPath=<tmpdir> from message and args but keeps the command and stderr", async () => {
    const dir = await fixture();
    const secret = "C:/Users/someone private/AppData/Local/Temp/githydra-nohooks-abc";
    const err = await runGitWithInput(["-c", `core.hooksPath=${secret}`, "apply", "--cached", "-"], { cwd: dir }, "not a patch").catch((e) => e);
    expect(err).toBeInstanceOf(GitCommandError);
    const e = err as GitCommandError;
    expect(e.message).not.toContain("someone");
    expect(e.message).not.toContain("hooksPath");
    expect(e.message).toContain("git apply --cached -");
    expect(e.args).toEqual(["apply", "--cached", "-"]);
    expect(e.stderr.length).toBeGreaterThan(0);
  });

  it("direct construction strips every path-carrying pair, wherever it sits, and keeps path-free ones", () => {
    const e = new GitCommandError(
      "git -c core.hooksPath=/tmp/u diff -c x.y=C:/Users/me/z -c core.sshCommand=ssh x exited with code 1: boom",
      ["-c", "core.hooksPath=/tmp/u", "diff", "-c", "x.y=C:/Users/me/z", "-c", "core.sshCommand=ssh", "x"],
      1,
      "boom",
    );
    expect(e.message).toBe("git diff -c core.sshCommand=ssh x exited with code 1: boom");
    expect(e.args).toEqual(["diff", "-c", "core.sshCommand=ssh", "x"]);
  });
});

describe("readWorktreeBounded", () => {
  it("reads a normal file, and refuses one over the guard without reading it whole", async () => {
    const dir = await fixture();
    const abs = path.join(dir, "f.txt");
    const ok = await readWorktreeBounded(abs);
    expect(ok.kind === "ok" && ok.bytes.toString()).toBe("a\nB\nc\n");
    expect(await readWorktreeBounded(abs, 3)).toEqual({ kind: "reason", reason: "too-large" });
    expect(await readWorktreeBounded(abs, 6)).toMatchObject({ kind: "ok" });
    expect(await readWorktreeBounded(abs, 5)).toEqual({ kind: "reason", reason: "too-large" });
    expect(await readWorktreeBounded(path.join(dir, "nope"))).toEqual({ kind: "reason", reason: "deleted" });
    expect(await readWorktreeBounded(dir)).toEqual({ kind: "reason", reason: "not-a-file" });
  });

  it("reports a symlink instead of following it", async (ctx) => {
    const dir = await fixture();
    try {
      await fs.symlink(path.join(dir, "f.txt"), path.join(dir, "link"));
    } catch {
      ctx.skip(); // no symlink privilege on this machine
    }
    expect(await readWorktreeBounded(path.join(dir, "link"))).toEqual({ kind: "reason", reason: "symlink" });
  });
});
