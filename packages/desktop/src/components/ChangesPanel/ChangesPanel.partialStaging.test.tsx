// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { FileDiffResult, PartialStagingEligibility, WorkingDirectoryChanges } from "@githydra/git-core";
import { ChangesPanel, type ChangesPanelProps } from "./ChangesPanel";
import { makeMockGitHydra } from "../../test/mockGitHydra";

// specs/hunk-line-staging.md FR-453/FR-454/FR-455 through the real ChangesPanel + useChangesPanel.

function Harness(props: Omit<ChangesPanelProps, "changes">) {
  const [changes, setChanges] = useState<WorkingDirectoryChanges | null | undefined>(undefined);
  const refetch = useCallback(() => {
    void props.api.getWorkingDirectoryChanges().then((r) => r.ok && setChanges(r.data));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.api]);
  useEffect(refetch, [refetch]);
  if (changes === undefined) return null;
  return (
    <ChangesPanel
      {...props}
      changes={changes}
      onWorkingDirChanged={() => {
        refetch();
        props.onWorkingDirChanged();
      }}
    />
  );
}

function makeDiff(fingerprint: string, partialStaging: PartialStagingEligibility = { eligible: true }, withHunks = true): FileDiffResult {
  return {
    status: "ok",
    isBinary: false,
    fingerprint,
    partialStaging,
    hunks: withHunks
      ? [
          {
            header: "@@ -1,2 +1,2 @@",
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 2,
            lines: [
              { type: "remove", content: "old", oldLineNumber: 1, newLineNumber: null },
              { type: "add", content: "new", oldLineNumber: null, newLineNumber: 1 },
              { type: "context", content: "same", oldLineNumber: 2, newLineNumber: 2 },
            ],
          },
        ]
      : [],
  };
}

const unstagedOnly: WorkingDirectoryChanges = {
  staged: [],
  unstaged: [{ path: "a.ts", status: "modified", category: "unstaged" }],
  untracked: [],
  conflicted: [],
};

function setup(changes: WorkingDirectoryChanges = unstagedOnly, diff: FileDiffResult = makeDiff("fp-1")) {
  const api = makeMockGitHydra({ workingDirectoryChanges: changes, fileDiff: diff });
  const onWorkingDirChanged = vi.fn();
  render(<Harness api={api} onClose={() => {}} onWorkingDirChanged={onWorkingDirChanged} onCommitCreated={() => {}} />);
  return { api, onWorkingDirChanged };
}

// Gutter labels now carry the line text ("Select added line 1: new").
const gutter = (name: string) => screen.findByRole("button", { name: new RegExp(`^${name}(:|$)`) });
const stageHunk = () => screen.findByRole("button", { name: "Stage hunk 1 of 1" });
const err = (name: string, message: string) => ({ ok: false as const, error: { name, message } });

describe("ChangesPanel hunk/line staging", () => {
  it("stages a hunk with the displayed fingerprint, then reloads the diff in place with scroll preserved", async () => {
    const { api, onWorkingDirChanged } = setup();
    fireEvent.click(await stageHunk());
    const box = document.querySelector<HTMLElement>(".gh-diff-view__hunks")!;
    box.scrollTop = 140;
    vi.mocked(api.getUnstagedFileDiff).mockResolvedValueOnce({ ok: true, data: makeDiff("fp-2") });

    fireEvent.click(screen.getByRole("button", { name: "Stage hunk 1 of 1" }));

    await waitFor(() => expect(api.stageSelection).toHaveBeenCalledWith("a.ts", "fp-1", [{ hunkIndex: 0 }]));
    await waitFor(() => expect(api.getUnstagedFileDiff).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onWorkingDirChanged).toHaveBeenCalled());
    // Same scroll container element (never unmounted through a "Loading diff" state), same offset.
    expect(document.querySelector(".gh-diff-view__hunks")).toBe(box);
    expect(box.scrollTop).toBe(140);
    expect(screen.queryByText(/loading diff/i)).not.toBeInTheDocument();
  });

  it("never passes through the loading state during the reload (AC9)", async () => {
    const { api } = setup();
    await stageHunk();
    let sawLoading = false;
    const observer = new MutationObserver(() => {
      if (screen.queryByText(/loading diff/i)) sawLoading = true;
    });
    observer.observe(document.body, { childList: true, subtree: true });
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk 1 of 1" }));
    await waitFor(() => expect(api.getUnstagedFileDiff).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    observer.disconnect();
    expect(sawLoading).toBe(false);
  });

  it("stages selected lines by their diff-line indexes", async () => {
    const { api } = setup();
    fireEvent.mouseDown(await gutter("Select added line 1"));
    fireEvent.mouseUp(window);
    fireEvent.click(screen.getByRole("button", { name: "Stage 1 line" }));
    await waitFor(() => expect(api.stageSelection).toHaveBeenCalledWith("a.ts", "fp-1", [{ hunkIndex: 0, lineIndexes: [1] }]));
  });

  it("STALE_DIFF: shows the disk-changed notice, reloads, shows no error, and never retries (AC4)", async () => {
    const { api } = setup();
    await stageHunk(); // initial diff loaded; the once-mocks below are for the reload
    vi.mocked(api.stageSelection).mockResolvedValueOnce(err("StaleDiffError", "The diff for a.ts changed."));
    const fresh = makeDiff("fp-2");
    if (fresh.status === "ok") fresh.hunks[0]!.header = "@@ -9,2 +9,2 @@";
    vi.mocked(api.getUnstagedFileDiff).mockResolvedValueOnce({ ok: true, data: fresh });

    fireEvent.click(screen.getByRole("button", { name: "Stage hunk 1 of 1" }));

    expect(
      await screen.findByText("The file changed on disk, so nothing was staged. Diff reloaded; select your lines again."),
    ).toBeInTheDocument();
    await screen.findByText("@@ -9,2 +9,2 @@");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(api.getUnstagedFileDiff).toHaveBeenCalledTimes(2));
    expect(api.stageSelection).toHaveBeenCalledTimes(1);
    // The user re-selects against the fresh diff, which carries the new fingerprint.
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk 1 of 1" }));
    await waitFor(() => expect(api.stageSelection).toHaveBeenLastCalledWith("a.ts", "fp-2", [{ hunkIndex: 0 }]));
  });

  it("other failures show a one-line summary beside the diff, full stderr behind Show details, and busy resets (AC11)", async () => {
    const { api, onWorkingDirChanged } = setup();
    vi.mocked(api.stageSelection).mockResolvedValueOnce(
      err(
        "GitCommandError",
        "git -c core.fsmonitor=false -c core.hooksPath=C:/x apply --cached - exited with code 128:\nfatal: Unable to create '.git/index.lock': File exists.",
      ),
    );

    fireEvent.click(await stageHunk());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't stage: another git process holds index.lock");
    expect(alert.closest(".gh-changes-panel__diff")).not.toBeNull(); // adjacent to the diff, not the file list
    expect(alert).not.toHaveTextContent("core.fsmonitor");
    fireEvent.click(within(alert).getByRole("button", { name: "Show details" }));
    expect(alert).toHaveTextContent("Unable to create '.git/index.lock'");
    expect(alert).not.toHaveTextContent("core.hooksPath");
    // Re-reads truth from git rather than trusting any local guess.
    await waitFor(() => expect(api.getUnstagedFileDiff).toHaveBeenCalledTimes(2));
    expect(onWorkingDirChanged).toHaveBeenCalled();
    expect(screen.getByText("Unstaged (1)")).toBeInTheDocument();
    // Not stuck busy: every hunk control is live again and a retry goes through.
    await waitFor(() => expect(screen.getByRole("button", { name: "Stage hunk 1 of 1" })).not.toHaveAttribute("aria-disabled"));
    expect(screen.getByRole("button", { name: "Discard hunk 1 of 1" })).not.toHaveAttribute("aria-disabled");
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk 1 of 1" }));
    await waitFor(() => expect(api.stageSelection).toHaveBeenCalledTimes(2));
  });

  it("Discard hunk asks for confirmation naming the file and count, says unrecoverable; Cancel does nothing (AC8)", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Discard hunk 1 of 1" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(
      "Discard 1 hunk (lines 1–2) from a.ts? This permanently removes the change from your working tree. This cannot be undone.",
    );
    expect(screen.getByRole("button", { name: "Discard hunk" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(); // irreversible: default to the safe choice
    expect(api.discardSelection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.discardSelection).not.toHaveBeenCalled();
  });

  it("confirming a line discard calls discardSelection with the fingerprint captured at click time", async () => {
    const { api } = setup();
    fireEvent.mouseDown(await gutter("Select removed line 1"));
    fireEvent.mouseUp(window);
    fireEvent.click(screen.getByRole("button", { name: "Discard 1 line" }));

    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Discard 1 line from a.ts?");
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard 1 line" }));

    await waitFor(() => expect(api.discardSelection).toHaveBeenCalledWith("a.ts", "fp-1", [{ hunkIndex: 0, lineIndexes: [0] }]));
  });

  it("the staged side offers Unstage hunk and calls unstageSelection", async () => {
    const { api } = setup({
      staged: [{ path: "a.ts", status: "modified", category: "staged" }],
      unstaged: [],
      untracked: [],
      conflicted: [],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Unstage hunk 1 of 1" }));
    await waitFor(() => expect(api.unstageSelection).toHaveBeenCalledWith("a.ts", "fp-1", [{ hunkIndex: 0 }]));
    expect(screen.queryByRole("button", { name: /discard hunk/i })).not.toBeInTheDocument();
  });

  it("shows no hunk/line controls for an ineligible file, and whole-file controls remain (AC7)", async () => {
    setup(unstagedOnly, makeDiff("fp-x", { eligible: false, reason: "renamed" }));
    await screen.findByText("@@ -1,2 +1,2 @@");
    expect(document.querySelector(".gh-diff-view__hunk-btn")).toBeNull();
    expect(document.querySelector("[data-gutter]")).toBeNull();
    expect(screen.getByRole("button", { name: /^stage$/i })).toBeInTheDocument();
  });

  it("shows no hunk/line controls for an untracked file", async () => {
    setup({
      staged: [],
      unstaged: [],
      untracked: [{ path: "a.ts", status: "added", category: "untracked" }],
      conflicted: [],
    });
    await screen.findByText("@@ -1,2 +1,2 @@");
    expect(document.querySelector(".gh-diff-view__hunk-btn")).toBeNull();
  });

  it("when the last hunk leaves the unstaged side, follows the file to its staged diff", async () => {
    const both: WorkingDirectoryChanges = { ...unstagedOnly };
    const { api } = setup(both);
    await stageHunk();
    vi.mocked(api.getUnstagedFileDiff).mockResolvedValueOnce({ ok: true, data: makeDiff("fp-empty", { eligible: true }, false) });
    vi.mocked(api.getStagedFileDiff).mockResolvedValue({ ok: true, data: makeDiff("fp-staged") });

    fireEvent.click(screen.getByRole("button", { name: "Stage hunk 1 of 1" }));

    expect(await screen.findByRole("button", { name: "Unstage hunk 1 of 1" })).toBeInTheDocument();
  });
});
