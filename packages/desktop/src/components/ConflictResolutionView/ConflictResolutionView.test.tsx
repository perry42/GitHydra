// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConflictResolutionView } from "./ConflictResolutionView";
import { makeMockGitHydra } from "../../test/mockGitHydra";
import { makeConflictedFile } from "../../test/fixtures";

// The default probe says "editable"; the file-level view is only used for files the block editor cannot open (FR-556).
const INELIGIBLE = { ok: true as const, data: { eligible: false as const, reason: "conflicted" as const, message: "Conflicted file: use the conflict resolution view" } };
function mk(opts: Parameters<typeof makeMockGitHydra>[0], eligible = false) {
  const api = makeMockGitHydra(opts);
  if (!eligible) vi.mocked(api.probeEditableFile).mockResolvedValue(INELIGIBLE);
  return api;
}

const sideLabels = {
  ours: { label: "Your branch (feature-x @ a1b2c3d)", refName: "feature-x", sha: "a1b2c3d" },
  theirs: { label: "Incoming (main @ d4e5f6a)", refName: "main", sha: "d4e5f6a" },
};

describe("ConflictResolutionView (FR-64/65/72)", () => {
  it("shows a three-way diff with real side labels, never the bare words ours/theirs (FR-61)", async () => {
    const api = mk({
      conflictedFiles: [makeConflictedFile("a.ts")],
      conflictSideLabels: sideLabels,
      conflictFileDiff: {
        baseToOurs: null,
        baseToTheirs: null,
        oursToTheirs: {
          status: "ok",
          isBinary: false,
          hunks: [
            {
              header: "@@ -1 +1 @@",
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: [{ type: "add", content: "conflicting content", oldLineNumber: null, newLineNumber: 1 }],
            },
          ],
        },
      },
    });
    render(<ConflictResolutionView api={api} path="a.ts" onClose={() => {}} onResolved={() => {}} />);

    await waitFor(() => expect(screen.getByText("conflicting content")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /take your branch \(feature-x @ a1b2c3d\)/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /take incoming \(main @ d4e5f6a\)/i })).toBeInTheDocument();
    expect(screen.queryByText(/\bours\b/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\btheirs\b/i)).not.toBeInTheDocument();
  });

  it("clicking Take Your branch calls acceptConflictSide with 'ours' and then shows the file as resolved", async () => {
    const onResolved = vi.fn();
    const api = mk({
      conflictedFiles: [makeConflictedFile("a.ts")],
      conflictSideLabels: sideLabels,
    });
    render(<ConflictResolutionView api={api} path="a.ts" onClose={() => {}} onResolved={onResolved} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /take your branch/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /take your branch/i }));

    expect(vi.mocked(api.acceptConflictSide)).toHaveBeenCalledWith("a.ts", "ours", true);
    await waitFor(() => expect(screen.getByText(/this file is resolved/i)).toBeInTheDocument());
    expect(onResolved).toHaveBeenCalled();
  });

  it("blocks Mark as resolved with a specific reason when conflict markers remain (FR-66/AC4)", async () => {
    const api = mk({
      conflictedFiles: [makeConflictedFile("a.ts")],
      conflictSideLabels: sideLabels,
      conflictMarkerScan: { hasMarkers: true, markerLines: [4] },
    });
    render(<ConflictResolutionView api={api} path="a.ts" onClose={() => {}} onResolved={() => {}} />);

    const markResolved = await screen.findByRole("button", { name: /mark as resolved/i });
    await waitFor(() => expect(markResolved).toBeDisabled());
    expect(markResolved).toHaveAttribute("title", expect.stringMatching(/conflict markers still present/i));
  });

  /**
   * specs/graph-head-indicator-and-refresh-alerting.md Problem 2 AC4: while an externally-detected
   * operation-state alert is unacknowledged, resolve actions must be blocked here too, not just
   * StatusBanner's Continue/Abort — this is the other half of the same gate.
   */
  it("disables Take-side/Mark as resolved while blockActions is true, and re-enables once cleared", async () => {
    const api = mk({
      conflictedFiles: [makeConflictedFile("a.ts")],
      conflictSideLabels: sideLabels,
    });
    const { rerender } = render(
      <ConflictResolutionView api={api} path="a.ts" onClose={() => {}} onResolved={() => {}} blockActions />,
    );

    const acceptOurs = await screen.findByRole("button", { name: /take your branch/i });
    expect(acceptOurs).toBeDisabled();
    expect(screen.getByRole("button", { name: /take incoming/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /mark as resolved/i })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/changed outside githydra/i);

    rerender(
      <ConflictResolutionView api={api} path="a.ts" onClose={() => {}} onResolved={() => {}} blockActions={false} />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /take your branch/i })).toBeEnabled());
    expect(screen.getByRole("button", { name: /take incoming/i })).toBeEnabled();
  });

  it("shows explicit 'deleted in X, modified in Y' copy for a delete/modify conflict, no diff pane (FR-78/AC9)", async () => {
    const api = mk({
      conflictedFiles: [makeConflictedFile("a.ts", { ours: null })],
      conflictSideLabels: sideLabels,
    });
    render(<ConflictResolutionView api={api} path="a.ts" onClose={() => {}} onResolved={() => {}} />);

    await waitFor(() =>
      expect(
        screen.getByText(/deleted in your branch \(feature-x @ a1b2c3d\), modified in incoming \(main @ d4e5f6a\)/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    // The side with no content is offered as a "(delete file)"-qualified accept action.
    expect(screen.getByRole("button", { name: /take your branch.*\(delete file\)/i })).toBeInTheDocument();
  });

  it("shows three candidate SHAs and no Mark-as-resolved for a submodule gitlink conflict, no text diff (FR-77/AC9)", async () => {
    const api = mk({
      conflictedFiles: [
        makeConflictedFile("libs/thing", {
          isSubmodule: true,
          base: { sha: "base0001111111111111111111111111111111", mode: "160000" },
          ours: { sha: "ours0001111111111111111111111111111111", mode: "160000" },
          theirs: { sha: "thei0001111111111111111111111111111111", mode: "160000" },
        }),
      ],
      conflictSideLabels: sideLabels,
    });
    render(<ConflictResolutionView api={api} path="libs/thing" onClose={() => {}} onResolved={() => {}} />);

    await waitFor(() => expect(screen.getByText("base000")).toBeInTheDocument());
    expect(screen.getByText("ours000")).toBeInTheDocument();
    expect(screen.getByText("thei000")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /mark as resolved/i })).not.toBeInTheDocument();
    expect(vi.mocked(api.getConflictFileDiff)).not.toHaveBeenCalled();
  });

  it("shows the existing binary 'no content shown' state for a binary conflict, whole-file accept only (FR-80/AC9)", async () => {
    const api = mk({
      conflictedFiles: [makeConflictedFile("image.png", { isBinary: true })],
      conflictSideLabels: sideLabels,
      conflictFileDiff: {
        baseToOurs: null,
        baseToTheirs: null,
        oursToTheirs: { status: "binary", isBinary: true },
      },
    });
    render(<ConflictResolutionView api={api} path="image.png" onClose={() => {}} onResolved={() => {}} />);

    await waitFor(() => expect(screen.getByText(/binary file/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /mark as resolved/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /take your branch/i })).toBeInTheDocument();
  });

  it("shows both sides' old->new path mapping for a rename conflict (FR-79/AC9)", async () => {
    const api = mk({
      conflictedFiles: [
        makeConflictedFile("new-name.ts", {
          rename: [
            { side: "ours", oldPath: "old-ours.ts", newPath: "new-name.ts" },
            { side: "theirs", oldPath: "old-theirs.ts", newPath: "new-name-2.ts" },
          ],
        }),
      ],
      conflictSideLabels: sideLabels,
    });
    render(<ConflictResolutionView api={api} path="new-name.ts" onClose={() => {}} onResolved={() => {}} />);

    await waitFor(() => expect(screen.getByText(/old-ours\.ts → new-name\.ts/)).toBeInTheDocument());
    expect(screen.getByText(/old-theirs\.ts → new-name-2\.ts/)).toBeInTheDocument();
  });

  it("opens the file in an external editor via the IPC bridge", async () => {
    const api = mk({
      conflictedFiles: [makeConflictedFile("a.ts")],
      conflictSideLabels: sideLabels,
    });
    render(<ConflictResolutionView api={api} path="a.ts" onClose={() => {}} onResolved={() => {}} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /open in external editor/i })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole("button", { name: /open in external editor/i }));
    expect(vi.mocked(api.openPathInExternalEditor)).toHaveBeenCalledWith("a.ts");
  });

  it("shows an explicit 'N of M conflicts resolved' count that shrinks as files resolve (FR-67)", async () => {
    const api = mk({
      conflictedFiles: [makeConflictedFile("a.ts"), makeConflictedFile("b.ts")],
      conflictSideLabels: sideLabels,
    });
    render(<ConflictResolutionView api={api} path="a.ts" onClose={() => {}} onResolved={() => {}} />);

    await waitFor(() => expect(screen.getByText("0 of 2 files resolved")).toBeInTheDocument());
    await userEvent.click(await screen.findByRole("button", { name: /take your branch/i }));
    await waitFor(() => expect(screen.getByText(/this file is resolved/i)).toBeInTheDocument());
  });

  it("an editor-eligible file offers Resolve in editor and hides the Take buttons; others say why and offer Take (specs/edit-in-diff.md FR-556, FR-566)", async () => {
    const onResolveInEditor = vi.fn();
    const api = mk({ conflictedFiles: [makeConflictedFile("a.ts")], conflictSideLabels: sideLabels }, true);
    const { unmount } = render(<ConflictResolutionView api={api} path="a.ts" onClose={() => {}} onResolved={() => {}} onResolveInEditor={onResolveInEditor} />);
    await userEvent.click(await screen.findByRole("button", { name: "Resolve in editor" }));
    expect(onResolveInEditor).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /^take / })).toBeNull();
    expect(screen.queryByTestId("no-editor-reason")).toBeNull();
    unmount();

    const cases = [
      [{ ours: null }, /one side deleted this file/i],
      [{ isBinary: true }, /no text blocks/i],
    ] as const;
    for (const [over, why] of cases) {
      const other = mk({ conflictedFiles: [makeConflictedFile("b.ts", over)], conflictSideLabels: sideLabels });
      const view = render(<ConflictResolutionView api={other} path="b.ts" onClose={() => {}} onResolved={() => {}} onResolveInEditor={onResolveInEditor} />);
      expect(await screen.findByTestId("no-editor-reason")).toHaveTextContent(why);
      expect(screen.queryByRole("button", { name: "Resolve in editor" })).toBeNull();
      expect(screen.getByRole("button", { name: /^take your branch/i })).toBeInTheDocument();
      view.unmount();
    }
  });

  it("Take asks first only when the working file differs from what git left; Cancel changes nothing (FR-566)", async () => {
    const api = mk({ conflictedFiles: [makeConflictedFile("a.ts")], conflictSideLabels: sideLabels, conflictFileUntouched: false });
    render(<ConflictResolutionView api={api} path="a.ts" onClose={() => {}} onResolved={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /^take your branch/i }));
    const dlg = await screen.findByRole("alertdialog");
    expect(dlg).toHaveTextContent(/differs from what git left/i);
    await userEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
    expect(vi.mocked(api.acceptConflictSide)).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /^take your branch/i }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Take it" }));
    expect(vi.mocked(api.acceptConflictSide)).toHaveBeenCalledWith("a.ts", "ours", true);
  });

  it("Take goes straight through when the working file is untouched (FR-566)", async () => {
    const api = mk({ conflictedFiles: [makeConflictedFile("a.ts")], conflictSideLabels: sideLabels, conflictFileUntouched: true });
    render(<ConflictResolutionView api={api} path="a.ts" onClose={() => {}} onResolved={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /^take incoming/i }));
    await waitFor(() => expect(vi.mocked(api.acceptConflictSide)).toHaveBeenCalledWith("a.ts", "theirs", true));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("maps main's overwrite-not-confirmed refusal to a plain message (FR-566)", async () => {
    const api = mk({ conflictedFiles: [makeConflictedFile("a.ts")], conflictSideLabels: sideLabels });
    vi.mocked(api.acceptConflictSide).mockResolvedValueOnce({ ok: false, error: { name: "OverwriteNotConfirmedError", code: "overwrite-not-confirmed", message: "raw" } });
    render(<ConflictResolutionView api={api} path="a.ts" onClose={() => {}} onResolved={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /take your branch/i }));
    expect(await screen.findByText(/nothing was replaced/i)).toBeInTheDocument();
  });

  it("explains a refused stage on a file that is no longer unmerged instead of showing git's raw message (FR-558)", async () => {
    const api = mk({ conflictedFiles: [makeConflictedFile("a.ts")], conflictSideLabels: sideLabels });
    vi.mocked(api.acceptConflictSide).mockResolvedValueOnce({ ok: false, error: { name: "NotConflictedError", message: 'Cannot resolve "a.ts": it is not currently in a conflicted state.' } });
    const onResolved = vi.fn();
    render(<ConflictResolutionView api={api} path="a.ts" onClose={() => {}} onResolved={onResolved} />);
    await userEvent.click(await screen.findByRole("button", { name: /take your branch/i }));
    expect(await screen.findByText(/This file is no longer in a conflicted state, so nothing was changed\./)).toBeInTheDocument();
    expect(onResolved).toHaveBeenCalled();
  });
});
