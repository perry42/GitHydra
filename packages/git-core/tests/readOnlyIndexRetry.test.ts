// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { retryReadOnlyIndexRace, _setIndexRetryDelaysForTests, withReadOnlyIndex, withFsmonitorNeutralized } from "../src/gitProcess";
import { GitCommandError } from "../src/errors";

const RACE = "fatal: .git/index: index file open failed: Permission denied\n";
const raceError = (args: readonly string[]) => new GitCommandError("git failed", args, 128, RACE);

beforeEach(() => _setIndexRetryDelaysForTests([1, 1, 1, 1]));
afterEach(() => _setIndexRetryDelaysForTests(null));

describe("retryReadOnlyIndexRace (Windows index.lock rename race)", () => {
  const readArgs = withReadOnlyIndex(["ls-files", "--stage"]);

  it("retries a read-only command that hits the race and returns the later success", async () => {
    let calls = 0;
    const r = await retryReadOnlyIndexRace(readArgs, { cwd: "." }, async () => {
      if (++calls < 3) throw raceError(readArgs);
      return "ok";
    });
    expect(r).toBe("ok");
    expect(calls).toBe(3);
  });

  it("gives up after a bounded number of attempts and rethrows the original error", async () => {
    let calls = 0;
    await expect(
      retryReadOnlyIndexRace(readArgs, { cwd: "." }, async () => {
        calls++;
        throw raceError(readArgs);
      }),
    ).rejects.toBeInstanceOf(GitCommandError);
    expect(calls).toBe(5);
  });

  it("never retries a mutation (queue flag or no read-only marker)", async () => {
    for (const [args, opts] of [
      [readArgs, { cwd: ".", mutatesRepository: true }],
      [withFsmonitorNeutralized(["add", "--", "a"]), { cwd: "." }],
    ] as const) {
      let calls = 0;
      await expect(
        retryReadOnlyIndexRace(args, opts, async () => {
          calls++;
          throw raceError(args);
        }),
      ).rejects.toBeInstanceOf(GitCommandError);
      expect(calls).toBe(1);
    }
  });

  it("does not retry other failures", async () => {
    let calls = 0;
    await expect(
      retryReadOnlyIndexRace(readArgs, { cwd: "." }, async () => {
        calls++;
        throw new GitCommandError("git failed", readArgs, 128, "fatal: not a git repository");
      }),
    ).rejects.toBeInstanceOf(GitCommandError);
    expect(calls).toBe(1);
  });

  it("stops retrying once the caller aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    await expect(
      retryReadOnlyIndexRace(readArgs, { cwd: ".", signal: ac.signal }, async () => {
        calls++;
        throw raceError(readArgs);
      }),
    ).rejects.toBeInstanceOf(GitCommandError);
    expect(calls).toBe(1);
  });
});
