// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FetchStatusBanner } from "./FetchStatusBanner";

describe("FetchStatusBanner", () => {
  it("renders nothing while idle", () => {
    const { container } = render(
      <FetchStatusBanner
        phase="idle"
        fetchSequence={0}
        latestProgress={null}
        outcomes={null}
        topLevelError={null}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows an unconditional Cancel affordance and elapsed time while fetching (repo-open-feedback pattern reused)", () => {
    render(
      <FetchStatusBanner
        phase="fetching"
        fetchSequence={1}
        latestProgress={null}
        outcomes={null}
        topLevelError={null}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/fetching remotes/i)).toBeInTheDocument();
    expect(screen.getByText(/^0s$/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  /**
   * A fetch against a private remote legitimately blocks on the OS credential helper's OWN window,
   * which opens OUTSIDE GitHydra and can appear behind it — this happened twice on a real machine
   * during development, and both times the window was easy to miss, making the app look hung. So
   * the hint has to name what the user is looking for and where, not just say "check for a popup."
   * Locked in here because it's the kind of copy that gets quietly trimmed later.
   */
  it("after 5s, tells the user a sign-in window may have opened outside the app, and where to find it", async () => {
    vi.useFakeTimers();
    try {
      render(
        <FetchStatusBanner
          phase="fetching"
          fetchSequence={1}
          latestProgress={null}
          outcomes={null}
          topLevelError={null}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
        />,
      );
      expect(screen.queryByText(/sign-in window/i)).not.toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(6000);
      });

      const hint = screen.getByText(/sign-in window/i);
      expect(hint).toBeInTheDocument();
      // Names the window, says it's outside the app, and says where to look for it.
      expect(hint.textContent).toMatch(/Git Credential Manager/i);
      expect(hint.textContent).toMatch(/outside GitHydra/i);
      expect(hint.textContent).toMatch(/taskbar|app switcher/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the latest progress line's remote/stage/percent while fetching", () => {
    render(
      <FetchStatusBanner
        phase="fetching"
        fetchSequence={1}
        latestProgress={{ remoteName: "origin", stage: "Compressing objects", percent: 42, raw: "raw" }}
        outcomes={null}
        topLevelError={null}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/origin: Compressing objects 42%/)).toBeInTheDocument();
  });

  it("treats a null stage as normal, not an error (git-core's own observed real-world shape)", () => {
    render(
      <FetchStatusBanner
        phase="fetching"
        fetchSequence={1}
        latestProgress={{ remoteName: "origin", stage: null, percent: null, raw: "remote: Total 3 (delta 0)" }}
        outcomes={null}
        topLevelError={null}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/^— origin$/)).toBeInTheDocument();
  });

  it("calls onCancel when Cancel is clicked", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <FetchStatusBanner
        phase="fetching"
        fetchSequence={1}
        latestProgress={null}
        outcomes={null}
        topLevelError={null}
        onCancel={onCancel}
        onDismiss={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows a top-level error distinctly, dismissible", async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(
      <FetchStatusBanner
        phase="done"
        fetchSequence={1}
        latestProgress={null}
        outcomes={null}
        topLevelError="No repository is open"
        onCancel={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/no repository is open/i);
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("reports zero remotes as a neutral, non-error state", () => {
    render(
      <FetchStatusBanner
        phase="done"
        fetchSequence={1}
        latestProgress={null}
        outcomes={[]}
        topLevelError={null}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/no remotes configured/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows each remote's own outcome truthfully — a successful remote alongside a failed one, never collapsed to one opaque result (FR-321)", () => {
    render(
      <FetchStatusBanner
        phase="done"
        fetchSequence={1}
        latestProgress={null}
        outcomes={[
          { remoteName: "origin", status: "ok" },
          {
            remoteName: "upstream",
            status: "error",
            error: { kind: "host-unreachable", message: "Could not reach the remote host.", rawStderr: "ssh: connect refused" },
          },
        ]}
        topLevelError={null}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/origin/).closest("li")).toHaveTextContent(/fetched successfully/i);
    expect(screen.getByText(/could not reach the remote host/i)).toBeInTheDocument();
  });

  it("never shows raw stderr inline — it's behind a collapsible Details disclosure (FR-323)", () => {
    render(
      <FetchStatusBanner
        phase="done"
        fetchSequence={1}
        latestProgress={null}
        outcomes={[
          {
            remoteName: "origin",
            status: "error",
            error: { kind: "unknown", message: "Something went wrong.", rawStderr: "fatal: some very specific raw stderr text" },
          },
        ]}
        topLevelError={null}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    // The raw text exists in the DOM (never hidden entirely — FR-323) but inside a closed
    // <details>, so it isn't part of what's immediately visible without expanding it.
    const details = screen.getByText("Details").closest("details");
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText(/fatal: some very specific raw stderr text/)).toBeInTheDocument();
  });
});
