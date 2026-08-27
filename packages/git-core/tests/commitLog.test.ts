import { describe, it, expect, afterEach } from "vitest";
import { CommitLogReader, findCommitsBySha } from "../src/commitLog";
import { git, initRepo, writeFile, commit, cleanup } from "./testRepo";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

async function readAll(reader: CommitLogReader, pageSize = 2) {
  const all = [];
  for (;;) {
    const page = await reader.readPage(pageSize);
    all.push(...page.commits);
    if (page.done) break;
  }
  reader.close();
  return all;
}

describe("CommitLogReader", () => {
  it("reads a linear history in the correct (newest-first) order", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    const c1 = await commit(dir, "first");
    await writeFile(dir, "a.txt", "2");
    const c2 = await commit(dir, "second");
    await writeFile(dir, "a.txt", "3");
    const c3 = await commit(dir, "third");

    const reader = new CommitLogReader(dir, undefined);
    const commits = await readAll(reader);

    expect(commits.map((c) => c.sha)).toEqual([c3, c2, c1]);
    expect(commits[0]!.parents).toEqual([c2]);
    expect(commits[2]!.parents).toEqual([]);
    expect(commits[0]!.subject).toBe("third");
  });

  it("pages correctly across many small readPage calls without dropping or duplicating commits", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    const shas: string[] = [];
    for (let i = 0; i < 25; i++) {
      await writeFile(dir, "a.txt", String(i));
      shas.push(await commit(dir, `commit ${i}`));
    }
    shas.reverse();

    const reader = new CommitLogReader(dir, undefined);
    const commits = await readAll(reader, 3); // page size doesn't evenly divide 25
    expect(commits.map((c) => c.sha)).toEqual(shas);
  });

  it("never requires reading the whole history before the first page (bounded first read)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    for (let i = 0; i < 50; i++) {
      await writeFile(dir, "a.txt", String(i));
      await commit(dir, `commit ${i}`);
    }
    const reader = new CommitLogReader(dir, undefined);
    const page = await reader.readPage(5);
    expect(page.commits).toHaveLength(5);
    expect(page.done).toBe(false);
    reader.close();
  });

  it("correctly reports both parents of a merge commit", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "base");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "b.txt", "feature");
    const featureSha = await commit(dir, "feature work");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "c.txt", "main work");
    const mainSha = await commit(dir, "main work");
    await git(dir, ["merge", "-q", "--no-ff", "-m", "merge feature", "feature"]);

    const reader = new CommitLogReader(dir, undefined);
    const commits = await readAll(reader);
    const mergeCommit = commits.find((c) => c.subject === "merge feature");
    expect(mergeCommit).toBeDefined();
    expect(mergeCommit!.parents).toHaveLength(2);
    expect(mergeCommit!.parents).toEqual(expect.arrayContaining([mainSha, featureSha]));
  });

  it("correctly reports 3+ parents for an octopus merge", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "base");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "b1"]);
    await writeFile(dir, "b1.txt", "1");
    await commit(dir, "b1 work");
    await git(dir, ["checkout", "-q", "main"]);
    await git(dir, ["checkout", "-q", "-b", "b2"]);
    await writeFile(dir, "b2.txt", "1");
    await commit(dir, "b2 work");
    await git(dir, ["checkout", "-q", "main"]);
    await git(dir, ["merge", "-q", "--no-ff", "-m", "octopus merge", "b1", "b2"]);

    const reader = new CommitLogReader(dir, undefined);
    const commits = await readAll(reader);
    const octopus = commits.find((c) => c.subject === "octopus merge");
    expect(octopus).toBeDefined();
    expect(octopus!.parents.length).toBeGreaterThanOrEqual(3);
  });

  it("reads both components of an orphan-branch repo without error, keeping them separate roots", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "main");
    const mainSha = await commit(dir, "main root");
    await git(dir, ["checkout", "-q", "--orphan", "orphan-branch"]);
    await git(dir, ["rm", "-rf", "--quiet", "."]).catch(() => {});
    await writeFile(dir, "b.txt", "orphan");
    const orphanSha = await commit(dir, "orphan root");

    const reader = new CommitLogReader(dir, undefined);
    const commits = await readAll(reader);
    const roots = commits.filter((c) => c.parents.length === 0);
    expect(roots.map((c) => c.sha).sort()).toEqual([mainSha, orphanSha].sort());
  });

  it("returns no commits, without throwing, for a zero-commit repo", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    const reader = new CommitLogReader(dir, undefined);
    const page = await reader.readPage(10);
    expect(page.commits).toEqual([]);
    expect(page.done).toBe(true);
    reader.close();
  });

  it("does not drop a commit whose message contains a literal RS (0x1e) byte (regression: record separator must be collision-proof)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    const beforeSha = await commit(dir, "before");
    await writeFile(dir, "a.txt", "2");
    // A literal ASCII RS (0x1e) control byte is legal content for a commit message — git
    // does not reject or strip it — but the old record separator (also 0x1e) would collide
    // with it here and silently desync/drop this record. The record separator is now NUL
    // (0x00), which cannot appear in a commit message, so this must parse cleanly.
    const trickyMessage = "subject with RS\x1ebyte\n\nbody line one\nbody with RS\x1ebyte too";
    const trickySha = await commit(dir, trickyMessage);
    await writeFile(dir, "a.txt", "3");
    const afterSha = await commit(dir, "after");

    const reader = new CommitLogReader(dir, undefined);
    const commits = await readAll(reader);

    // All three commits present — none silently dropped because of the embedded RS byte.
    expect(commits.map((c) => c.sha)).toEqual([afterSha, trickySha, beforeSha]);

    const tricky = commits.find((c) => c.sha === trickySha)!;
    expect(tricky.subject).toBe("subject with RS\x1ebyte");
    expect(tricky.body).toBe("body line one\nbody with RS\x1ebyte too");

    // Sanity: neighboring commits weren't corrupted by the collision either.
    expect(commits.find((c) => c.sha === beforeSha)!.subject).toBe("before");
    expect(commits.find((c) => c.sha === afterSha)!.subject).toBe("after");
  });

  describe("filters", () => {
    it("filters by author substring", async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "a.txt", "1");
      await commit(dir, "by test author");
      await writeFile(dir, "a.txt", "2");
      await git(dir, ["add", "-A"]);
      await git(dir, [
        "-c",
        "user.name=Someone Else",
        "-c",
        "user.email=someone@else.com",
        "commit",
        "-q",
        "-m",
        "by someone else",
        "--author=Someone Else <someone@else.com>",
      ]);

      const reader = new CommitLogReader(dir, { author: "someone" });
      const commits = await readAll(reader);
      expect(commits).toHaveLength(1);
      expect(commits[0]!.subject).toBe("by someone else");
    });

    it("filters by message substring (fixed-string, case-insensitive by default)", async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "a.txt", "1");
      await commit(dir, "Fix the WIDGET bug");
      await writeFile(dir, "a.txt", "2");
      await commit(dir, "add sprocket feature");

      const reader = new CommitLogReader(dir, { messageSubstring: "widget" });
      const commits = await readAll(reader);
      expect(commits).toHaveLength(1);
      expect(commits[0]!.subject).toBe("Fix the WIDGET bug");
    });

    it("treats message substring as a literal string, not a regex", async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "a.txt", "1");
      await commit(dir, "cost: $5.00 (was $4.00)");

      const reader = new CommitLogReader(dir, { messageSubstring: "$5.00 (was" });
      const commits = await readAll(reader);
      expect(commits).toHaveLength(1);
    });

    it("filters by date range", async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "a.txt", "1");
      await git(dir, ["add", "-A"]);
      // git log --since/--until filter on commit (committer) date, not author date, so both
      // must be backdated for this fixture to actually land outside the filtered range.
      await git(dir, ["commit", "-q", "-m", "old commit", "--date=2020-01-01T00:00:00"], {
        GIT_COMMITTER_DATE: "2020-01-01T00:00:00",
      });
      await writeFile(dir, "a.txt", "2");
      const recentSha = await commit(dir, "recent commit");

      const reader = new CommitLogReader(dir, { dateFrom: "2024-01-01" });
      const commits = await readAll(reader);
      expect(commits.map((c) => c.sha)).toEqual([recentSha]);
    });

    it("filters by file path", async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "a.txt", "1");
      await commit(dir, "touch a");
      await writeFile(dir, "b.txt", "1");
      const bSha = await commit(dir, "touch b");
      await writeFile(dir, "a.txt", "2");
      await commit(dir, "touch a again");

      const reader = new CommitLogReader(dir, { paths: ["b.txt"] });
      const commits = await readAll(reader);
      expect(commits.map((c) => c.sha)).toEqual([bSha]);
    });

    it("rejects a ref name that looks like an option, instead of misinterpreting it (argument-injection guard)", async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "a.txt", "1");
      await commit(dir, "first");

      // Validation happens eagerly at construction time, before any git process is spawned.
      expect(() => new CommitLogReader(dir, { refs: ["--upload-pack=/bin/false"] })).toThrow();
    });

    it("resolves a ref literally named like a flag (no '=', so it passes the character-class check) as a revision, not an option — proving --end-of-options is actually in effect", async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "a.txt", "1");
      const sha = await commit(dir, "first");

      // `--upload-pack=/bin/false` (used in the test above) is rejected by validateShaLike's
      // character-class check before --end-of-options even comes into play, so it never
      // actually exercises the --end-of-options protection. A ref name with no '=' — e.g. a
      // branch literally called "--upload-pack" — passes that check and reaches git's argv,
      // so it's this shape of name that actually proves the protection works. `git branch`
      // itself refuses to create such a name, but `update-ref` (a lower-level, real thing a
      // repo's on-disk refs can legitimately contain) does not enforce that restriction.
      await git(dir, ["update-ref", "refs/heads/--upload-pack", sha]);

      // Without --end-of-options, `git log --format=... --upload-pack` fails outright with
      // "fatal: unrecognized argument: --upload-pack" (verified manually) rather than silently
      // misbehaving — so if this construction/read did NOT go through --end-of-options, this
      // would throw here instead of returning the commit.
      const reader = new CommitLogReader(dir, { refs: ["--upload-pack"] });
      const commits = await readAll(reader);
      expect(commits.map((c) => c.sha)).toEqual([sha]);
    });
  });
});

describe("findCommitsBySha", () => {
  it("finds a commit by full SHA", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    const sha = await commit(dir, "first");

    const matches = await findCommitsBySha(dir, sha);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.sha).toBe(sha);
  });

  it("finds a commit by abbreviated SHA prefix", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    const sha = await commit(dir, "first");

    const matches = await findCommitsBySha(dir, sha.slice(0, 8));
    expect(matches.map((c) => c.sha)).toContain(sha);
  });

  it("returns an empty array for a SHA prefix that matches nothing", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "first");

    const matches = await findCommitsBySha(dir, "deadbeef");
    expect(matches).toEqual([]);
  });

  it("rejects a non-hex value rather than passing it through to git", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "first");

    await expect(findCommitsBySha(dir, "--not-a-sha")).rejects.toThrow();
  });
});
