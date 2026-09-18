// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PushStatusBanner } from "./PushStatusBanner";

const base = {
  pushSequence: 1,
  latestProgress: null,
  outcome: null,
  error: null,
  isNonFastForwardRejection: false,
  rawStderr: null,
  onCancel: vi.fn(),
  onDismiss: vi.fn(),
} as const;

describe("PushStatusBanner (specs/online-sync-push.md FR-346/FR-348)", () => {
  it("renders nothing while idle", () => {
    const { container } = render(<PushStatusBanner {...base} phase="idle" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows an unconditional Cancel affordance and elapsed time while pushing (reuses FetchStatusBanner's own pattern)", () => {
    render(<PushStatusBanner {...base} phase="pushing" />);
    expect(screen.getByText(/pushing/i)).toBeInTheDocument();
    expect(screen.getByText(/^0s$/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("after 5s, tells the user a sign-in window may have opened outside the app — same reused fetch-phase hint", async () => {
    vi.useFakeTimers();
    try {
      render(<PushStatusBanner {...base} phase="pushing" />);
      expect(screen.queryByText(/sign-in prompt/i)).not.toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(6000);
      });

      expect(screen.getByText(/sign-in prompt/i)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the latest progress line's remote/stage/percent while pushing", () => {
    render(
      <PushStatusBanner
        {...base}
        phase="pushing"
        latestProgress={{ remoteName: "origin", stage: "Writing objects", percent: 77, raw: "raw" }}
      />,
    );
    expect(screen.getByText(/origin: Writing objects 77%/)).toBeInTheDocument();
  });

  it("calls onCancel when Cancel is clicked", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<PushStatusBanner {...base} phase="pushing" onCancel={onCancel} />);
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("FR-344/FR-345: distinguishes a plain tracked push from a set-upstream publish — never one generic 'Push complete' line", () => {
    const { rerender } = render(
      <PushStatusBanner
        {...base}
        phase="done"
        outcome={{ kind: "pushed", remoteName: "origin", localBranch: "main", remoteBranch: "main", sha: "a".repeat(40) }}
      />,
    );
    expect(screen.getByText(/pushed "main" to origin\/main/i)).toBeInTheDocument();

    rerender(
      <PushStatusBanner
        {...base}
        phase="done"
        outcome={{ kind: "set-upstream", remoteName: "origin", localBranch: "feature", remoteBranch: "feature", sha: "b".repeat(40) }}
      />,
    );
    expect(screen.getByText(/published "feature".*set it as the upstream/i)).toBeInTheDocument();
  });

  it("FR-346: a non-fast-forward rejection shows the specific 'pull first' message, never a generic error line or any force wording", async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(
      <PushStatusBanner
        {...base}
        phase="done"
        error="The remote has commits you don't have. Pull first, then push again."
        isNonFastForwardRejection={true}
        rawStderr="! [rejected]        main -> main (non-fast-forward)"
        onDismiss={onDismiss}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/pull first/i);
    // The message text is allowed to reassure ("...never auto-retries...any force option") — the
    // hard non-goal is never OFFERING a force escalation as an action, not avoiding the word.
    expect(screen.queryByRole("button", { name: /force/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /force/i })).not.toBeInTheDocument();

    // FR-348: raw stderr is available but collapsed behind Details, matching FetchStatusBanner's
    // own collapsible-raw-stderr shape — never dumped inline.
    expect(screen.queryByText(/non-fast-forward/)).not.toBeVisible();
    await user.click(screen.getByText("Details"));
    expect(screen.getByText(/non-fast-forward/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("shows a genuine (non-rejection) failure distinctly, dismissible", async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(
      <PushStatusBanner
        {...base}
        phase="done"
        error='"main" is not a local branch in this repository.'
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/not a local branch/i);
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders nothing in the 'done' phase when there's neither an outcome nor an error", () => {
    const { container } = render(<PushStatusBanner {...base} phase="done" />);
    expect(container).toBeEmptyDOMElement();
  });
});
