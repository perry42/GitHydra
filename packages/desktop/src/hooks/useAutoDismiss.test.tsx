// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { autoDismissDelayFor } from "./useAutoDismiss";
import { FetchStatusBanner } from "../components/FetchStatusBanner/FetchStatusBanner";
import { PullStatusBanner } from "../components/PullStatusBanner/PullStatusBanner";
import { PushStatusBanner } from "../components/PushStatusBanner/PushStatusBanner";
import { StatusBanner } from "../components/StatusBanner/StatusBanner";
import { LeftBehindBanner } from "../components/LeftBehindBanner/LeftBehindBanner";
import { makeRepoState } from "../test/fixtures";
import type { FetchRemoteOutcome } from "@githydra/git-core";

// specs/auto-dismiss-status-messages.md: plain success banners (and only those) time out.

let hasFocus = true;
beforeEach(() => {
  vi.useFakeTimers();
  hasFocus = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => hasFocus);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const tick = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};
const pullOutcome = { kind: "up-to-date" } as never;
const pushOutcome = { kind: "pushed", remoteName: "origin", localBranch: "main", remoteBranch: "main", sha: "a" } as never;
const okOutcomes: FetchRemoteOutcome[] = [{ remoteName: "origin", status: "ok" }];
const noop = vi.fn();

/** Stateful harness mirroring App.tsx's wiring: onDismiss flips phase back to idle. */
function PullHarness({ onDismissSpy }: { onDismissSpy?: () => void }) {
  const [phase, setPhase] = useState<"idle" | "pulling" | "done">("done");
  return (
    <PullStatusBanner
      phase={phase}
      pullSequence={1}
      latestProgress={null}
      outcome={pullOutcome}
      error={null}
      onCancel={() => {}}
      onDismiss={() => {
        onDismissSpy?.();
        setPhase("idle");
      }}
    />
  );
}

const pushBase = {
  latestProgress: null,
  outcome: pushOutcome,
  error: null,
  isNonFastForwardRejection: false,
  rawStderr: null,
  onCancel: noop,
};

describe("autoDismissDelayFor", () => {
  it("is 6s for short copy, grows ~40ms/char past 80 chars, capped at 10s", () => {
    expect(autoDismissDelayFor(40)).toBe(6000);
    expect(autoDismissDelayFor(80)).toBe(6000);
    expect(autoDismissDelayFor(90)).toBe(6400);
    expect(autoDismissDelayFor(1000)).toBe(10000);
  });
});

describe("auto-dismiss of plain success banners", () => {
  it("pull success disappears ~6s after it appears; role=status is kept", () => {
    render(<PullHarness />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    tick(5900);
    expect(screen.getByRole("status")).toBeInTheDocument();
    tick(200);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("fetch (all ok) calls onDismiss at 6s", () => {
    const spy = vi.fn();
    render(<FetchStatusBanner phase="done" fetchSequence={1} latestProgress={null} outcomes={okOutcomes} topLevelError={null} onCancel={noop} onDismiss={spy} />);
    tick(5900);
    expect(spy).not.toHaveBeenCalled();
    tick(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("fetch (no remotes configured) calls onDismiss at 6s", () => {
    const spy = vi.fn();
    render(<FetchStatusBanner phase="done" fetchSequence={1} latestProgress={null} outcomes={[]} topLevelError={null} onCancel={noop} onDismiss={spy} />);
    tick(6100);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("push calls onDismiss at 6s", () => {
    const spy = vi.fn();
    render(<PushStatusBanner phase="done" pushSequence={1} {...pushBase} onDismiss={spy} />);
    tick(5900);
    expect(spy).not.toHaveBeenCalled();
    tick(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("manual Dismiss works before the timer, and the timer does not fire again", () => {
    const spy = vi.fn();
    render(<PullHarness onDismissSpy={spy} />);
    tick(1000);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(spy).toHaveBeenCalledTimes(1);
    tick(10000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("hover at 5s holds the banner until leave, then a FULL new delay starts", () => {
    render(<PullHarness />);
    const banner = screen.getByRole("status");
    tick(5000);
    fireEvent.pointerEnter(banner);
    tick(60000);
    expect(screen.getByRole("status")).toBeInTheDocument();
    fireEvent.pointerLeave(banner);
    tick(5900);
    expect(screen.getByRole("status")).toBeInTheDocument();
    tick(200);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("focus on Dismiss pauses; blur restarts the full delay", () => {
    render(<PullHarness />);
    const btn = screen.getByRole("button", { name: /dismiss/i });
    tick(4000);
    fireEvent.focus(btn);
    tick(60000);
    expect(screen.getByRole("status")).toBeInTheDocument();
    fireEvent.blur(btn);
    tick(5900);
    expect(screen.getByRole("status")).toBeInTheDocument();
    tick(200);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not steal focus on appear", () => {
    render(<PullHarness />);
    expect(document.body).toHaveFocus();
  });

  it("window blur at 4s pauses; refocus restarts the full delay", () => {
    render(<PullHarness />);
    tick(4000);
    hasFocus = false;
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    tick(60000);
    expect(screen.getByRole("status")).toBeInTheDocument();
    hasFocus = true;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    tick(5900);
    expect(screen.getByRole("status")).toBeInTheDocument();
    tick(200);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a hidden document also pauses", () => {
    render(<PullHarness />);
    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    tick(60000);
    expect(screen.getByRole("status")).toBeInTheDocument();
    spy.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    tick(6100);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a new push starting at 3s cancels the pending timer; a stale timer cannot dismiss the newer banner", () => {
    const spy = vi.fn();
    const { rerender } = render(<PushStatusBanner phase="done" pushSequence={1} {...pushBase} onDismiss={spy} />);
    tick(3000);
    rerender(<PushStatusBanner phase="pushing" pushSequence={2} {...pushBase} outcome={null} onDismiss={spy} />);
    tick(20000);
    expect(spy).not.toHaveBeenCalled();
    rerender(<PushStatusBanner phase="done" pushSequence={2} {...pushBase} onDismiss={spy} />);
    tick(5900);
    expect(spy).not.toHaveBeenCalled();
    tick(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a new fetch at 3s after a push: the push state resets to idle and its timer never fires", () => {
    const spy = vi.fn();
    const { rerender } = render(<PushStatusBanner phase="done" pushSequence={1} {...pushBase} onDismiss={spy} />);
    tick(3000);
    rerender(<PushStatusBanner phase="idle" pushSequence={1} {...pushBase} outcome={null} onDismiss={spy} />);
    tick(20000);
    expect(spy).not.toHaveBeenCalled();
  });

  it("reduced motion: removal is instant (no animation/transition inline styles involved)", () => {
    const { container } = render(<PullHarness />);
    expect(container.querySelector("[style]")).toBeNull();
    tick(6100);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("banners that must NEVER auto-dismiss", () => {
  it("fetch with a failed remote", () => {
    const spy = vi.fn();
    const outcomes: FetchRemoteOutcome[] = [
      { remoteName: "origin", status: "ok" },
      { remoteName: "up", status: "error", error: { message: "nope", rawStderr: "x" } as never },
    ];
    render(<FetchStatusBanner phase="done" fetchSequence={1} latestProgress={null} outcomes={outcomes} topLevelError={null} onCancel={noop} onDismiss={spy} />);
    tick(120000);
    expect(spy).not.toHaveBeenCalled();
  });

  it("fetch success list longer than 2 lines", () => {
    const spy = vi.fn();
    const outcomes: FetchRemoteOutcome[] = ["a", "b", "c"].map((remoteName) => ({ remoteName, status: "ok" as const }));
    render(<FetchStatusBanner phase="done" fetchSequence={1} latestProgress={null} outcomes={outcomes} topLevelError={null} onCancel={noop} onDismiss={spy} />);
    tick(120000);
    expect(spy).not.toHaveBeenCalled();
  });

  it("fetch top-level error", () => {
    const spy = vi.fn();
    render(<FetchStatusBanner phase="done" fetchSequence={1} latestProgress={null} outcomes={null} topLevelError="boom" onCancel={noop} onDismiss={spy} />);
    tick(120000);
    expect(spy).not.toHaveBeenCalled();
  });

  it("in-flight fetch/pull/push banners", () => {
    const spy = vi.fn();
    render(
      <>
        <FetchStatusBanner phase="fetching" fetchSequence={1} latestProgress={null} outcomes={null} topLevelError={null} onCancel={noop} onDismiss={spy} />
        <PullStatusBanner phase="pulling" pullSequence={1} latestProgress={null} outcome={null} error={null} onCancel={noop} onDismiss={spy} />
        <PushStatusBanner phase="pushing" pushSequence={1} {...pushBase} outcome={null} onDismiss={spy} />
      </>,
    );
    tick(120000);
    expect(spy).not.toHaveBeenCalled();
  });

  it("pull error", () => {
    const spy = vi.fn();
    render(<PullStatusBanner phase="done" pullSequence={1} latestProgress={null} outcome={null} error="diverged" onCancel={noop} onDismiss={spy} />);
    tick(120000);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("push rejection (non-fast-forward) and a generic push error", () => {
    const spy = vi.fn();
    render(
      <>
        <PushStatusBanner phase="done" pushSequence={1} {...pushBase} outcome={null} error="rejected" isNonFastForwardRejection rawStderr="r" onDismiss={spy} />
        <PushStatusBanner phase="done" pushSequence={2} {...pushBase} outcome={null} error="auth" onDismiss={spy} />
      </>,
    );
    tick(120000);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getAllByRole("alert")).toHaveLength(2);
  });

  it("operation banner (rebase in progress)", () => {
    render(<StatusBanner repoState={makeRepoState({ inProgressOperation: "rebase" })} hasExternalChanges={false} onRefresh={() => {}} />);
    tick(120000);
    expect(screen.getByText(/rebase in progress/i)).toBeInTheDocument();
  });

  it("the history-changed-outside banner", () => {
    render(<StatusBanner repoState={makeRepoState()} hasExternalChanges onRefresh={() => {}} />);
    tick(120000);
    expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument();
  });

  it("left-behind banner", () => {
    const spy = vi.fn();
    render(<LeftBehindBanner info={{ headSha: "abc1234567", shortSha: "abc1234", total: 3, totalIsCapped: false, unknown: false }} onCreateBranch={noop} onDismiss={spy} />);
    tick(120000);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByText(/left 3 commits behind/i)).toBeInTheDocument();
  });

  it("reset-undo banner", () => {
    const spy = vi.fn();
    render(
      <StatusBanner
        repoState={makeRepoState()}
        hasExternalChanges={false}
        onRefresh={() => {}}
        onDismissResetUndoBanner={spy}
        resetUndoBanner={{ mode: "hard", producedSha: "t".repeat(40), previousSha: "p".repeat(40), previousAbbrevSha: "ppppppp", previousSubject: "s", branchLabel: "main" }}
      />,
    );
    tick(120000);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /undo/i })).toBeInTheDocument();
  });
});
