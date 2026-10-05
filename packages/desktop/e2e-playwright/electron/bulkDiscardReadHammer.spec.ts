// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Diagnostic for the field report "bulkDiscard returned partial right after app open": hammers the app's own read IPCs
 * (status, worktree diffs, combined diff, fingerprints) from the renderer while a 15-file bulkDiscard runs, through the
 * real preload bridge. Any `partial` / `failed` result is the bug (a read racing .git/index.lock).
 */
import { test, expect } from "@playwright/test";
import { closeApp, removeUserDataDir, type LaunchedApp } from "../helpers/launchApp";
import { launchApp, openChanges } from "../helpers/changesHelpers";
import { cleanup, commitAll, initRepo, writeFile } from "../../src/test/gitFixture";

let h: LaunchedApp;
const dirs: string[] = [];
test.beforeEach(async () => {
  h = await launchApp();
});
test.afterEach(async () => {
  await closeApp(h);
  await removeUserDataDir(h.userDataDir);
  while (dirs.length) await cleanup(dirs.pop()!);
});

for (const run of [1, 2]) {
  test(`read hammer run ${run}: bulkDiscard stays complete while the app hammers its read IPCs`, async () => {
    test.setTimeout(300_000);
    const d = await initRepo();
    dirs.push(d);
    for (let i = 1; i <= 25; i++) await writeFile(d, `t${i}.txt`, "base\n");
    await writeFile(d, "other.txt", "base\n");
    await commitAll(d, "base");
    // Written back-to-back, so the index's stat data is "racily clean" and every status wants to refresh it.
    for (let i = 1; i <= 25; i++) await writeFile(d, `t${i}.txt`, "changed\n");
    await writeFile(d, "other.txt", "changed\n");
    await openChanges(h, d);

    const result = await h.window.evaluate(async () => {
      const api = (window as unknown as { gitHydra: Record<string, (...a: unknown[]) => Promise<{ ok: boolean; data?: any; error?: any }>> }).gitHydra;
      const cands = Array.from({ length: 25 }, (_, i) => ({ path: `t${i + 1}.txt`, section: "unstaged" }));
      const fps = (await api.getBulkDiscardFingerprints!(cands)).data as { path: string; section: string; expectedFingerprint?: string }[];
      const rows = fps.map((f) => ({ path: f.path, section: f.section, expectedFingerprint: f.expectedFingerprint }));
      let stop = false;
      const errors: string[] = [];
      const loop = async (fn: () => Promise<{ ok: boolean; error?: any }>) => {
        while (!stop) {
          const r = await fn();
          if (!r.ok) errors.push(JSON.stringify(r.error).slice(0, 200));
        }
      };
      const hammers = [
        loop(() => api.getWorkingDirectoryChanges!()),
        loop(() => api.getWorkingDirectoryChanges!()),
        loop(() => api.getUnstagedFileDiff!("other.txt")),
        loop(() => api.getCombinedFileDiff!("other.txt")),
        loop(() => api.getDiscardFingerprint!("other.txt", "tracked")),
        loop(() => api.getWorkingDirectoryChanges!()),
        loop(() => api.getWorkingDirectoryChanges!()),
        loop(() => api.getWorkingDirectoryChanges!()),
        loop(() => api.getDiscardFingerprint!("other.txt", "tracked")),
        loop(() => api.getDiscardFingerprint!("other.txt", "tracked")),
      ];
      const res = await api.bulkDiscard!(rows);
      stop = true;
      await Promise.all(hammers);
      return { res, errors };
    });
    console.log(`RUN ${run}:`, JSON.stringify({ ok: result.res.ok, status: result.res.data?.status, failed: result.res.data?.failed, error: result.res.error, hammerErrors: result.errors.slice(0, 3), n: result.errors.length }));
    expect(result.res.ok).toBe(true);
    expect(result.res.data.status).toBe("complete");
    expect(result.res.data.discarded.length).toBe(25);
  });
}
