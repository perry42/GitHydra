// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PullStatusBanner } from "./PullStatusBanner";

describe("PullStatusBanner (specs/online-sync-pull.md FR-338/FR-339)", () => {
  it("renders nothing while idle", () => {
    const { container } = render(
      <PullStatusBanner
        phase="idle"
        pullSequence={0}
        latestProgress={null}
        outcome={null}
        error={null}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows an unconditional Cancel affordance and elapsed time while pulling (reuses FetchStatusBanner's own pattern)", () => {
    render(
      <PullStatusBanner
        phase="pulling"
        pullSequence={1}
        latestProgress={null}
        outcome={null}
        error={null}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/pulling/i)).toBeInTheDocument();
    expect(screen.getByText(/^0s$/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("after 5s, tells the user a sign-in window may have opened outside the app — same reused fetch-phase hint", async () => {
    vi.useFakeTimers();
    try {
      render(
        <PullStatusBanner
          phase="pulling"
          pullSequence={1}
          latestProgress={null}
          outcome={null}
          error={null}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
        />,
      );
      expect(screen.queryByText(/sign-in prompt/i)).not.toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(6000);
      });

      expect(screen.getByText(/sign-in prompt/i)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the latest progress line's remote/stage/percent while pulling", () => {
    render(
      <PullStatusBanner
        phase="pulling"
        pullSequence={1}
        latestProgress={{ remoteName: "origin", stage: "Compressing objects", percent: 42, raw: "raw" }}
        outcome={null}
        error={null}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/origin: Compressing objects 42%/)).toBeInTheDocument();
  });

  it("calls onCancel when Cancel is clicked", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <PullStatusBanner
        phase="pulling"
        pullSequence={1}
        latestProgress={null}
        outcome={null}
        error={null}
        onCancel={onCancel}
        onDismiss={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("FR-338: distinguishes 'up to date' from a fast-forward and from a real merge/rebase — never one generic 'Pull complete' line", () => {
    const { rerender } = render(
      <PullStatusBanner
        phase="done"
        pullSequence={1}
        latestProgress={null}
        outcome={{ kind: "up-to-date" }}
        error={null}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/already up to date/i)).toBeInTheDocument();

    rerender(
      <PullStatusBanner
        phase="done"
        pullSequence={1}
        latestProgress={null}
        outcome={{ kind: "fast-forward", fromSha: "a".repeat(40), toSha: "b".repeat(40) }}
        error={null}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/fast-forwarded/i)).toBeInTheDocument();
    expect(screen.getByText(/bbbbbbb/)).toBeInTheDocument();

    rerender(
      <PullStatusBanner
        phase="done"
        pullSequence={1}
        latestProgress={null}
        outcome={{ kind: "integrated", strategy: "merge" }}
        error={null}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/merge commit was created/i)).toBeInTheDocument();

    rerender(
      <PullStatusBanner
        phase="done"
        pullSequence={1}
        latestProgress={null}
        outcome={{ kind: "integrated", strategy: "rebase" }}
        error={null}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/rebased onto the incoming changes/i)).toBeInTheDocument();
  });

  it("shows a genuine (non-conflict-pause) error distinctly, dismissible", async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(
      <PullStatusBanner
        phase="done"
        pullSequence={1}
        latestProgress={null}
        outcome={null}
        error="No upstream is configured for the current branch."
        onCancel={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/no upstream is configured/i);
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders nothing in the 'done' phase when there's neither an outcome nor an error — e.g. a conflict pause, handled entirely by StatusBanner/ConflictResolutionView instead", () => {
    const { container } = render(
      <PullStatusBanner
        phase="done"
        pullSequence={1}
        latestProgress={null}
        outcome={null}
        error={null}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
