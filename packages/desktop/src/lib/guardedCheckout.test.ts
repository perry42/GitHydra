// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import type { OrphanedHeadResult } from "@githydra/git-core";
import { GitHydraIpcError } from "../hooks/gitHydraClient";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { createGuardedCheckout, HEAD_CHANGED_MESSAGE, type OrphanPromptDecision, type OrphanPromptRequest } from "./guardedCheckout";

const HEAD = "a".repeat(40);
const NEW_HEAD = "b".repeat(40);

function orphaned(over: Partial<OrphanedHeadResult> = {}): OrphanedHeadResult {
  return {
    status: "orphaned",
    reason: "orphaned",
    headSha: HEAD,
    total: 2,
    totalIsCapped: false,
    shown: [
      { sha: HEAD, shortSha: "aaaaaaa", subject: "second" },
      { sha: "c".repeat(40), shortSha: "ccccccc", subject: "first" },
    ],
    ...over,
  };
}
const NONE: OrphanedHeadResult = { status: "none", reason: "attached", headSha: null, total: 0, totalIsCapped: false, shown: [] };
const ok = <T,>(data: T) => ({ ok: true as const, data });

function setup(results: OrphanedHeadResult[], decisions: OrphanPromptDecision[]) {
  const api = makeMockGitHydra();
  const queue = [...results];
  vi.mocked(api.getOrphanedHeadCommits).mockImplementation(async () => ok(queue.length > 1 ? queue.shift()! : queue[0]!));
  const prompt = vi.fn(async (_req: OrphanPromptRequest) => decisions.shift() ?? "cancel");
  const onLeftBehind = vi.fn();
  const onHeadMoved = vi.fn();
  const guard = createGuardedCheckout({ api, prompt, onLeftBehind, onHeadMoved });
  return { api, prompt, guard, onLeftBehind, onHeadMoved };
}

describe("createGuardedCheckout (FR-430 choke point)", () => {
  it("none: proceeds without a dialog and passes no expected sha", async () => {
    const { api, prompt, guard } = setup([NONE], []);
    const out = await guard.switchBranch("main");
    expect(out.cancelled).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
    expect(api.switchBranch).toHaveBeenCalledWith("main");
  });

  it("orphaned then Cancel: changes nothing (no switch call, no banner)", async () => {
    const { api, prompt, guard, onLeftBehind } = setup([orphaned()], ["cancel"]);
    const out = await guard.switchToCommit("deadbeef");
    expect(out).toEqual({ cancelled: true });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(api.switchToCommit).not.toHaveBeenCalled();
    expect(api.switchBranch).not.toHaveBeenCalled();
    expect(onLeftBehind).not.toHaveBeenCalled();
  });

  it("orphaned then Leave: passes the shown headSha as expectedDetachedHeadSha and reports the left-behind info", async () => {
    const { api, guard, onLeftBehind } = setup([orphaned()], ["leave"]);
    const onMutationStart = vi.fn();
    await guard.switchBranch("main", { onMutationStart });
    expect(api.switchBranch).toHaveBeenCalledWith("main", { expectedDetachedHeadSha: HEAD });
    expect(onMutationStart).toHaveBeenCalledTimes(1);
    expect(onLeftBehind).toHaveBeenCalledWith({
      headSha: HEAD,
      shortSha: HEAD.slice(0, 7),
      total: 2,
      totalIsCapped: false,
      unknown: false,
    });
  });

  it("unknown is treated like orphaned (asks); an IPC failure of the query itself is unknown, never none", async () => {
    const unknown: OrphanedHeadResult = { status: "unknown", reason: "timeout", headSha: HEAD, total: 0, totalIsCapped: false, shown: [] };
    const a = setup([unknown], ["cancel"]);
    await a.guard.switchBranch("main");
    expect(a.prompt).toHaveBeenCalledTimes(1);

    const b = setup([orphaned()], ["cancel"]);
    vi.mocked(b.api.getOrphanedHeadCommits).mockResolvedValue({ ok: false, error: { name: "X", message: "boom" } });
    await b.guard.switchBranch("main");
    expect(b.prompt).toHaveBeenCalledTimes(1);
    expect(b.prompt.mock.calls[0]![0].result.status).toBe("unknown");
    expect(b.api.switchBranch).not.toHaveBeenCalled();
  });

  it("HeadMovedError: does not proceed, refreshes, re-runs the guard and re-prompts with headMoved", async () => {
    const { api, prompt, guard, onHeadMoved } = setup([orphaned(), orphaned({ headSha: NEW_HEAD })], ["leave", "leave"]);
    vi.mocked(api.switchBranch)
      .mockResolvedValueOnce({ ok: false, error: { name: "HeadMovedError", message: "moved" } })
      .mockResolvedValueOnce(ok({ sha: "1".repeat(40) }));
    const onMutationSettled = vi.fn();
    const out = await guard.switchBranch("main", { onMutationSettled });
    expect(out.cancelled).toBe(false);
    expect(onHeadMoved).toHaveBeenCalledTimes(1);
    expect(onMutationSettled).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[0]![0].headMoved).toBe(false);
    expect(prompt.mock.calls[1]![0].headMoved).toBe(true);
    expect(vi.mocked(api.switchBranch).mock.calls[1]).toEqual(["main", { expectedDetachedHeadSha: NEW_HEAD }]);
  });

  it("HeadMovedError then HEAD now has nothing to lose: still does not switch, tells the user", async () => {
    const { api, guard } = setup([orphaned(), NONE], ["leave"]);
    vi.mocked(api.switchBranch).mockResolvedValueOnce({ ok: false, error: { name: "HeadMovedError", message: "moved" } });
    await expect(guard.switchBranch("main")).rejects.toThrow(HEAD_CHANGED_MESSAGE);
    expect(api.switchBranch).toHaveBeenCalledTimes(1);
  });

  it("create-then-continue: 'created' re-queries (never blindly retries) and then continues the checkout", async () => {
    const { api, prompt, guard, onLeftBehind } = setup([orphaned(), NONE], ["created"]);
    const out = await guard.switchBranch("main");
    expect(out.cancelled).toBe(false);
    expect(api.getOrphanedHeadCommits).toHaveBeenCalledTimes(2);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(api.switchBranch).toHaveBeenCalledWith("main"); // saved on a branch: no expected sha needed
    expect(onLeftBehind).not.toHaveBeenCalled();
  });

  it("create succeeded but the follow-on checkout fails: the error surfaces and there is no loop", async () => {
    const { api, prompt, guard } = setup([orphaned(), NONE], ["created"]);
    vi.mocked(api.switchBranch).mockResolvedValue({ ok: false, error: { name: "BranchSwitchConflictError", message: "local changes" } });
    await expect(guard.switchBranch("main")).rejects.toBeInstanceOf(GitHydraIpcError);
    expect(api.switchBranch).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("createBranchAndSwitch carries switchToIt and the confirmed expected sha", async () => {
    const { api, guard } = setup([orphaned()], ["leave"]);
    await guard.createBranchAndSwitch({ name: "feat", startPoint: "origin/feat", track: true });
    expect(api.createBranch).toHaveBeenCalledWith({
      name: "feat",
      startPoint: "origin/feat",
      track: true,
      switchToIt: true,
      expectedDetachedHeadSha: HEAD,
    });
  });
});
