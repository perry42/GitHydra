// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { getWorkingDirectoryStatus, parsePorcelainStatus } from "../src/workingDirStatus";
import { git, initRepo, writeFile, commit, cleanup, makeTempDir } from "./testRepo";

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

describe("parsePorcelainStatus", () => {
  it("reports no changes for empty porcelain output", () => {
    expect(parsePorcelainStatus("")).toEqual({
      hasChanges: false,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
    });
  });

  it("counts staged, unstaged, and untracked paths independently", () => {
    // "M " = staged modify, " M" = unstaged modify, "??" = untracked, "MM" = staged AND unstaged
    const porcelain = ["M  staged.txt", " M unstaged.txt", "?? new.txt", "MM both.txt", ""].join(
      "\n",
    );
    const result = parsePorcelainStatus(porcelain);
    expect(result.hasChanges).toBe(true);
    expect(result.staged).toBe(2); // staged.txt, both.txt
    expect(result.unstaged).toBe(2); // unstaged.txt, both.txt
    expect(result.untracked).toBe(1);
    expect(result.conflicted).toBe(0);
  });

  it("counts unmerged (conflict) combinations without double-counting them as staged/unstaged", () => {
    // Real conflict codes per `git status --porcelain` docs: UU, AA, DD, AU, UA, UD, DU.
    const porcelain = ["UU both-modified.txt", "AA both-added.txt", "DD both-deleted.txt", ""].join(
      "\n",
    );
    const result = parsePorcelainStatus(porcelain);
    expect(result.conflicted).toBe(3);
    expect(result.staged).toBe(0);
    expect(result.unstaged).toBe(0);
  });
});

describe("getWorkingDirectoryStatus", () => {
  it("reports zero changes for a clean working tree", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "hello");
    await commit(dir, "first");

    const status = await getWorkingDirectoryStatus(dir);
    expect(status).toEqual({
      hasChanges: false,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
    });
  });

  it("reports staged, unstaged, and untracked changes together", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await writeFile(dir, "b.txt", "1");
    await commit(dir, "base");

    await writeFile(dir, "a.txt", "2"); // unstaged modify
    await writeFile(dir, "b.txt", "2");
    await git(dir, ["add", "b.txt"]); // staged modify
    await writeFile(dir, "c.txt", "new"); // untracked

    const status = await getWorkingDirectoryStatus(dir);
    expect(status.hasChanges).toBe(true);
    expect(status.staged).toBe(1);
    expect(status.unstaged).toBe(1);
    expect(status.untracked).toBe(1);
    expect(status.conflicted).toBe(0);
  });

  it("reports an unresolved merge conflict as conflicted, not staged/unstaged", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    await commit(dir, "main change");
    await git(dir, ["merge", "-q", "feature"]).catch(() => {
      /* expected to fail with a conflict */
    });

    const status = await getWorkingDirectoryStatus(dir);
    expect(status.conflicted).toBe(1);
    expect(status.hasChanges).toBe(true);
  });

  // Regression test for the High-severity finding: a repo whose *local* .git/config sets
  // core.fsmonitor to an external command must NOT have that command executed just because
  // getWorkingDirectoryStatus() calls `git status`. This is not a hypothetical: `git status`
  // (unlike every other command this module runs) consults core.fsmonitor and, if it's not a
  // recognized boolean, executes it as an external hook — see workingDirStatus.ts's doc
  // comment. A repo distributed as a checkout/zip/tarball/bare-repo/worktree (all
  // explicitly-supported ways to open a repo in GitHydra, not just `git clone`, which never
  // copies this local config) can ship a malicious value here.
  describe("fsmonitor argument-injection guard", () => {
    async function setUpMaliciousFsmonitorRepo() {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "a.txt", "hello");
      await commit(dir, "first");

      // The malicious script and its marker file deliberately live OUTSIDE the repo's working
      // tree (a sibling temp dir), so this fixture doesn't itself add an extra untracked path
      // inside the repo and confuse the untracked-count assertion below — a real attacker
      // would just as easily point core.fsmonitor at an absolute path outside the repo.
      const outsideDir = await makeTempDir();
      cleanupDirs.push(outsideDir);
      // Forward slashes only: this path is interpolated into a shell script executed by
      // git-for-windows' bundled MSYS shell, where a raw Windows backslash inside a
      // double-quoted string is an escape character, not a path separator, and would corrupt
      // the path (this mirrors how the shallow-clone fixtures elsewhere in this suite
      // normalize Windows paths to forward slashes before handing them to a `file://` URL or
      // shell-executed context).
      const markerPath = `${outsideDir.replace(/\\/g, "/")}/PWNED_MARKER`;
      const scriptPath = `${outsideDir.replace(/\\/g, "/")}/fsmonitor-marker.sh`;
      await writeFile(outsideDir, "fsmonitor-marker.sh", `#!/bin/sh\necho PWNED > "${markerPath}"\n`);
      await git(dir, ["config", "core.fsmonitor", scriptPath]);
      await writeFile(dir, "b.txt", "untracked change to force a status computation");

      return { dir, markerPath };
    }

    // Positive control: proves the vulnerability is real in this test environment (not just
    // theoretical), by calling plain, un-neutralized `git status` directly — the same way the
    // old (pre-fix) packages/desktop/electron/workingDirStatus.ts did — and showing the
    // configured command actually executes.
    it("[vulnerability demonstration] plain `git status` with no -c override DOES execute a malicious core.fsmonitor command", async () => {
      const { dir, markerPath } = await setUpMaliciousFsmonitorRepo();
      expect(await fileExists(markerPath)).toBe(false);

      await git(dir, ["status", "--porcelain=v1", "--untracked-files=all"]);

      expect(await fileExists(markerPath)).toBe(true);
    });

    it("getWorkingDirectoryStatus() does NOT execute the malicious core.fsmonitor command", async () => {
      const { dir, markerPath } = await setUpMaliciousFsmonitorRepo();
      expect(await fileExists(markerPath)).toBe(false);

      const status = await getWorkingDirectoryStatus(dir);

      // The status call itself must still work correctly...
      expect(status.untracked).toBe(1);
      // ...and, critically, must NOT have executed the configured fsmonitor command. Without
      // the `-c core.fsmonitor=false` neutralization in workingDirStatus.ts, this would be
      // `true` — as proven by the sibling "[vulnerability demonstration]" test above running
      // the exact same malicious fixture through plain, un-neutralized `git status`.
      expect(await fileExists(markerPath)).toBe(false);
    });
  });
});
