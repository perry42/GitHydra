import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { useRepositoryGraph } from "./hooks/useRepositoryGraph";
import { useElapsedSeconds } from "./hooks/useElapsedSeconds";
import { makeMockGitHydra } from "./test/mockGitHydra";
import { makeCommit } from "./test/fixtures";
import type { IpcResult, OpenRepoOutcome } from "../shared/ipcContract";
import type { RepositoryState } from "@githydra/git-core";

/** specs/repo-open-feedback.md FR-166/AC1/AC6: the "Opening repository…" spinner's running
 * elapsed-time readout.
 *
 * Only `setInterval`/`clearInterval`/`Date` are faked (not `setTimeout`, which React's own
 * scheduler and `@testing-library/react`'s `act`/`waitFor` machinery rely on internally) — faking
 * the whole clock made every `act(async () => ...)` around a click hang indefinitely, since
 * React 18's scheduler never got to flush. `useElapsedSeconds` itself only ever calls
 * `setInterval`/`Date.now()`, so this narrower fake is sufficient to drive its clock deterministically
 * while leaving `userEvent`/`waitFor`'s own real-timer-based internals alone. */

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
});

/** A controllable, never-auto-resolving stand-in for `api.openRepoCancellable` — lets a test hold
 * the "opening" state open indefinitely and resolve it on its own schedule, the way a genuinely
 * slow `git` spawn (this spec's whole premise) would. `resolve` takes the plain `IpcResult` (as
 * `openRepo` itself would have returned) and wraps it in the `{ outcome: "settled", result }`
 * shape `openRepoCancellable` actually resolves with, so existing call sites below stay unchanged. */
function deferredOpenRepo(): {
  promise: Promise<OpenRepoOutcome>;
  resolve: (result: IpcResult<{ path: string; state: RepositoryState }>) => void;
} {
  let resolve!: (result: IpcResult<{ path: string; state: RepositoryState }>) => void;
  const promise = new Promise<OpenRepoOutcome>((res) => {
    resolve = (result) => res({ outcome: "settled", result });
  });
  return { promise, resolve };
}

function openRepoButton(): HTMLElement {
  return screen.getByRole("button", { name: "Open a repository" });
}

describe("repo-open elapsed-time indicator", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("AC1: shows running elapsed time, updating at least once per second, from the moment status flips to opening", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
    });
    window.gitHydra = api;
    const deferred = deferredOpenRepo();
    vi.mocked(api.openRepoCancellable).mockReturnValueOnce(deferred.promise);
    render(<App />);

    fireEvent.click(openRepoButton());

    // Starts from 0 the instant `status` flips to "opening" (before any tick fires).
    await waitFor(() => expect(screen.getByText("Opening repository…")).toBeInTheDocument());
    expect(screen.getByText("0s")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText("3s")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByText("7s")).toBeInTheDocument();

    // Resolving now must not regress the existing success path.
    const state = await api.getState();
    await act(async () => {
      deferred.resolve({ ok: true, data: { path: "/repoA", state: state.ok ? state.data! : ({} as RepositoryState) } });
    });
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    expect(screen.queryByText(/Opening repository/)).not.toBeInTheDocument();
  });

  it("AC6: a fast open never shows a nonzero elapsed value before resolving (no artificial minimum display duration)", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
    });
    window.gitHydra = api;
    render(<App />);

    // The mock's default `openRepoCancellable` resolves synchronously (well under 1s) — the
    // spinner should never render a nonzero elapsed value, and may not even be observable at all.
    fireEvent.click(openRepoButton());
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    expect(screen.queryByText(/^\d+s$/)).not.toBeInTheDocument();
  });

  // `useRepoTabs`'s `beginSwitch()`/`switching` guard already serializes every real UI entry point
  // (Toolbar's "Open repository…", "+ New tab", tab activation) so none of them can trigger a
  // second `graph.openRepo()` while one is still in flight — so this scenario isn't reachable
  // through `<App />` today. It's still the exact "stale timer bleeds into a new attempt" case the
  // `useRepositoryGraph.openRepo`/`openSequence` doc comments call out as a real possibility at the
  // hook layer (any future or non-UI-gated caller of `graph.openRepo` directly), so it's tested one
  // level down: a small harness rendering `useRepositoryGraph` + `useElapsedSeconds` wired exactly
  // as `OpeningSpinner` wires them, calling `openRepo` directly to bypass `useRepoTabs`'s gate.
  it("does not let a stale timer from a superseded open attempt bleed into a new one (a second openRepo() call while the first is still in flight)", async () => {
    function Harness() {
      const graph = useRepositoryGraph();
      const elapsedSeconds = useElapsedSeconds(graph.status === "opening", graph.openSequence);
      return (
        <div>
          <button onClick={() => void graph.openRepo("/repoA")}>open A</button>
          <button onClick={() => void graph.openRepo("/repoB")}>open B</button>
          <div data-testid="status">{graph.status}</div>
          {graph.status === "opening" && <div data-testid="elapsed">{elapsedSeconds}s</div>}
        </div>
      );
    }

    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      reposByPath: {
        "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] },
      },
    });
    window.gitHydra = api;
    const first = deferredOpenRepo();
    vi.mocked(api.openRepoCancellable).mockReturnValueOnce(first.promise);
    render(<Harness />);

    fireEvent.click(screen.getByText("open A"));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("opening"));
    expect(screen.getByTestId("elapsed")).toHaveTextContent("0s");

    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(screen.getByTestId("elapsed")).toHaveTextContent("8s");

    // A second `openRepo()` call supersedes the first while it's still in flight — `status` stays
    // "opening" throughout (no false->true edge for `useElapsedSeconds`'s `active` flag), only
    // `openSequence` bumps.
    const second = deferredOpenRepo();
    vi.mocked(api.openRepoCancellable).mockReturnValueOnce(second.promise);
    fireEvent.click(screen.getByText("open B"));

    // The clock must have restarted at 0 for the new attempt, not kept counting from 8.
    await waitFor(() => expect(screen.getByTestId("elapsed")).toHaveTextContent("0s"));

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId("elapsed")).toHaveTextContent("2s");

    const state = await api.getState();
    await act(async () => {
      second.resolve({ ok: true, data: { path: "/repoB", state: state.ok ? state.data! : ({} as RepositoryState) } });
    });
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
    // The superseded first attempt resolving afterward (generation mismatch) must be a no-op —
    // never resurrecting the spinner/elapsed readout for the attempt that lost the race.
    await act(async () => {
      first.resolve({ ok: true, data: { path: "/repoA", state: state.ok ? state.data! : ({} as RepositoryState) } });
    });
    expect(screen.getByTestId("status")).toHaveTextContent("ready");
    expect(screen.queryByTestId("elapsed")).not.toBeInTheDocument();
  });
});
