import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConflictResolutionView } from "./ConflictResolutionView";
import { makeMockGitHydra } from "../../test/mockGitHydra";
import { makeConflictedFile } from "../../test/fixtures";

const sideLabels = {
  ours: { label: "Your branch (feature-x @ a1b2c3d)", refName: "feature-x", sha: "a1b2c3d" },
  theirs: { label: "Incoming (main @ d4e5f6a)", refName: "main", sha: "d4e5f6a" },
};

describe("ConflictResolutionView (FR-64/65/72)", () => {
  it("shows a three-way diff with real side labels, never the bare words ours/theirs (FR-61)", async () => {
    const api = makeMockGitHydra({
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
    expect(screen.getByRole("button", { name: /accept your branch \(feature-x @ a1b2c3d\)/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /accept incoming \(main @ d4e5f6a\)/i })).toBeInTheDocument();
    expect(screen.queryByText(/\bours\b/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\btheirs\b/i)).not.toBeInTheDocument();
  });

  it("clicking Accept Ours calls acceptConflictSide with 'ours' and then shows the file as resolved", async () => {
    const onResolved = vi.fn();
    const api = makeMockGitHydra({
      conflictedFiles: [makeConflictedFile("a.ts")],
      conflictSideLabels: sideLabels,
    });
    render(<ConflictResolutionView api={api} path="a.ts" onClose={() => {}} onResolved={onResolved} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /accept your branch/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /accept your branch/i }));

    expect(vi.mocked(api.acceptConflictSide)).toHaveBeenCalledWith("a.ts", "ours");
    await waitFor(() => expect(screen.getByText(/this file is resolved/i)).toBeInTheDocument());
    expect(onResolved).toHaveBeenCalled();
  });

  it("blocks Mark as resolved with a specific reason when conflict markers remain (FR-66/AC4)", async () => {
    const api = makeMockGitHydra({
      conflictedFiles: [makeConflictedFile("a.ts")],
      conflictSideLabels: sideLabels,
      conflictMarkerScan: { hasMarkers: true, markerLines: [4] },
    });
    render(<ConflictResolutionView api={api} path="a.ts" onClose={() => {}} onResolved={() => {}} />);

    const markResolved = await screen.findByRole("button", { name: /mark as resolved/i });
    await waitFor(() => expect(markResolved).toBeDisabled());
    expect(markResolved).toHaveAttribute("title", expect.stringMatching(/conflict markers still present/i));
  });

  it("shows explicit 'deleted in X, modified in Y' copy for a delete/modify conflict, no diff pane (FR-78/AC9)", async () => {
    const api = makeMockGitHydra({
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
    expect(screen.getByRole("button", { name: /accept your branch.*\(delete file\)/i })).toBeInTheDocument();
  });

  it("shows three candidate SHAs and no Mark-as-resolved for a submodule gitlink conflict, no text diff (FR-77/AC9)", async () => {
    const api = makeMockGitHydra({
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
    const api = makeMockGitHydra({
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
    expect(screen.getByRole("button", { name: /accept your branch/i })).toBeInTheDocument();
  });

  it("shows both sides' old->new path mapping for a rename conflict (FR-79/AC9)", async () => {
    const api = makeMockGitHydra({
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
    const api = makeMockGitHydra({
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
    const api = makeMockGitHydra({
      conflictedFiles: [makeConflictedFile("a.ts"), makeConflictedFile("b.ts")],
      conflictSideLabels: sideLabels,
    });
    render(<ConflictResolutionView api={api} path="a.ts" onClose={() => {}} onResolved={() => {}} />);

    await waitFor(() => expect(screen.getByText("0 of 2 conflicts resolved")).toBeInTheDocument());
    await userEvent.click(await screen.findByRole("button", { name: /accept your branch/i }));
    await waitFor(() => expect(screen.getByText(/this file is resolved/i)).toBeInTheDocument());
  });
});
