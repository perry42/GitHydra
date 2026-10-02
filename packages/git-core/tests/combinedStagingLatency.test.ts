// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import { getCombinedFileDiff, toggleCombinedLines } from "../src/combinedStaging";
import { _getSpawnCountForTests } from "../src/gitProcess";
import { git, initRepo, writeFile, commit, cleanup } from "./testRepo";

/** Benchmark-style guard for FR-479/480 latency: logs timings, asserts only a generous bound so it is not flaky. */
const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await cleanup(dirs.pop()!);
});

function lines(n: number, edit: (i: number) => string | undefined = () => undefined): string {
  const out: string[] = [];
  for (let i = 1; i <= n; i++) out.push(edit(i) ?? `line ${i}`);
  return out.join("\n") + "\n";
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; spawns: number; value: T }> {
  const s0 = _getSpawnCountForTests();
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, spawns: _getSpawnCountForTests() - s0, value };
}

describe("combined staging latency", () => {
  it("opens a 300-line combined diff and toggles single lines within generous bounds", async () => {
    const dir = await initRepo();
    dirs.push(dir);
    await git(dir, ["config", "core.autocrlf", "false"]);
    await writeFile(dir, "f.txt", lines(300));
    await commit(dir, "base");
    await writeFile(dir, "f.txt", lines(300, (i) => (i % 15 === 0 ? `edited ${i}` : undefined)));

    const opens: number[] = [];
    let openSpawns = 0;
    let fp = "";
    for (let k = 0; k < 5; k++) {
      const r = await timed(() => getCombinedFileDiff(dir, "f.txt"));
      if (r.value.mode !== "combined") throw new Error("expected combined");
      fp = r.value.fingerprint;
      opens.push(r.ms);
      openSpawns = r.spawns;
    }

    const toggles: number[] = [];
    let toggleSpawns = 0;
    for (let k = 0; k < 6; k++) {
      const d = await getCombinedFileDiff(dir, "f.txt");
      if (d.mode !== "combined") throw new Error("expected combined");
      fp = d.fingerprint;
      // Alternate the first hunk's first added line between staged and unstaged.
      const h = d.hunks[0]!;
      const idx = h.lines.findIndex((l) => l.type === "add");
      const r = await timed(() =>
        toggleCombinedLines(dir, "f.txt", fp, [{ hunkIndex: 0, lineIndex: idx }], h.lines[idx]!.staged ? "unstage" : "stage"),
      );
      toggles.push(r.ms);
      toggleSpawns = r.spawns;
    }

    // eslint-disable-next-line no-console
    console.log(
      `[latency] open median=${median(opens).toFixed(0)}ms spawns=${openSpawns}; single-line toggle median=${median(toggles).toFixed(0)}ms spawns=${toggleSpawns}`,
    );
    expect(median(opens)).toBeLessThan(3000);
    expect(median(toggles)).toBeLessThan(3000);
  }, 60_000);

  it("stages a 100-line-changed hunk within a generous bound", async () => {
    const dir = await initRepo();
    dirs.push(dir);
    await git(dir, ["config", "core.autocrlf", "false"]);
    await writeFile(dir, "g.txt", lines(300));
    await commit(dir, "base");
    await writeFile(dir, "g.txt", lines(300, (i) => (i > 100 && i <= 200 ? `changed ${i}` : undefined)));
    const d = await getCombinedFileDiff(dir, "g.txt");
    if (d.mode !== "combined") throw new Error("expected combined");
    const refs = d.hunks.flatMap((h, hi) => h.lines.flatMap((l, li) => (l.type === "context" ? [] : [{ hunkIndex: hi, lineIndex: li }])));
    const r = await timed(() => toggleCombinedLines(dir, "g.txt", d.fingerprint, refs, "stage"));
    // eslint-disable-next-line no-console
    console.log(`[latency] 200-row hunk stage ${r.ms.toFixed(0)}ms spawns=${r.spawns}`);
    expect(r.ms).toBeLessThan(3000);
    const after = await getCombinedFileDiff(dir, "g.txt");
    expect(after.mode === "combined" && after.hunks.every((h) => h.stagedState === "all")).toBe(true);
  }, 60_000);
});
