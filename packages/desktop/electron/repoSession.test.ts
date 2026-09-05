import { beforeEach, describe, expect, it, vi } from "vitest";

// `Repository.open` is the only runtime value from @githydra/git-core that repoSession.ts calls
// directly — everything else it imports is type-only, so a minimal mock (no vi.importActual, no
// real git shelling) is enough to control resolution order deterministically.
vi.mock("@githydra/git-core", () => ({
  Repository: { open: vi.fn() },
}));

import { Repository } from "@githydra/git-core";
import { RepoSession } from "./repoSession";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fakeRepo(path: string) {
  return { path, getState: () => ({ path }) } as unknown as Awaited<ReturnType<typeof Repository.open>>;
}

/** A `fakeRepo` whose `watchForRefChanges()` returns a stub watcher exposing a spied `close()` —
 * for tests that need to prove `RepoSession` actually tore down the watcher it started, not just
 * whatever `fakeRepo()` alone can stand in for. */
function fakeRepoWithWatcher(path: string) {
  const watcherClose = vi.fn();
  const repo = {
    path,
    getState: () => ({ path }),
    watchForRefChanges: () => ({ close: watcherClose }),
  } as unknown as Awaited<ReturnType<typeof Repository.open>>;
  return { repo, watcherClose };
}

describe("RepoSession.open — concurrency guard", () => {
  it("keeps the most recently *started* open()'s repo as the live one, even if an earlier call's Repository.open() resolves later", async () => {
    const openMock = vi.mocked(Repository.open);
    const first = deferred<Awaited<ReturnType<typeof Repository.open>>>();
    const second = deferred<Awaited<ReturnType<typeof Repository.open>>>();
    openMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const session = new RepoSession();
    // Simulates two rapid, overlapping tab switches: call1 (repoA) fires, then call2 (repoB)
    // fires before call1's underlying Repository.open() has resolved.
    const p1 = session.open("/repoA");
    const p2 = session.open("/repoB");

    const repoA = fakeRepo("/repoA");
    const repoB = fakeRepo("/repoB");

    // The *newer* call (repoB) resolves first — the common case — but the guard must hold even
    // when, as here, the *older* call (repoA) is the one that resolves last.
    second.resolve(repoB);
    await p2;
    first.resolve(repoA);
    await p1;

    // repoB (the later call) must be what's live, never repoA (the stale one), regardless of
    // resolution order.
    expect(session.getOpenRepo()).toBe(repoB);
  });

  it("still resolves the stale call's own promise with its own repo (IPC contract unchanged) — it just isn't the live session repo", async () => {
    const openMock = vi.mocked(Repository.open);
    const first = deferred<Awaited<ReturnType<typeof Repository.open>>>();
    const second = deferred<Awaited<ReturnType<typeof Repository.open>>>();
    openMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const session = new RepoSession();
    const p1 = session.open("/repoA");
    const p2 = session.open("/repoB");

    const repoA = fakeRepo("/repoA");
    const repoB = fakeRepo("/repoB");
    second.resolve(repoB);
    await p2;
    first.resolve(repoA);

    await expect(p1).resolves.toBe(repoA);
    expect(session.getOpenRepo()).toBe(repoB);
  });

  it("a normal, non-overlapping sequence of opens still works", async () => {
    const openMock = vi.mocked(Repository.open);
    const repoA = fakeRepo("/repoA");
    const repoB = fakeRepo("/repoB");
    openMock.mockResolvedValueOnce(repoA).mockResolvedValueOnce(repoB);

    const session = new RepoSession();
    await session.open("/repoA");
    expect(session.getOpenRepo()).toBe(repoA);
    await session.open("/repoB");
    expect(session.getOpenRepo()).toBe(repoB);
  });
});

// specs/repo-open-feedback.md FR-163/FR-164: `RepoSession.open()`'s `requestId`/`cancelOpen()`
// plumbing is the IPC-facing half of the cancellation feature — `Repository.open()` itself is
// mocked here (its own real cancellation behavior is covered end-to-end against real git in
// packages/git-core's own test suite), so these tests verify the SESSION correctly threads a
// fresh `AbortController` per `requestId` and routes `cancelOpen()` to the right one.
describe("RepoSession.open/cancelOpen — cancellation plumbing (FR-163/FR-164)", () => {
  // The shared `openMock` (hoisted, module-scoped) accumulates call history across every test in
  // this file — reset it so each test here can rely on its own absolute call count/index instead
  // of accounting for whatever earlier describe blocks already called it with.
  beforeEach(() => {
    vi.mocked(Repository.open).mockReset();
  });

  it("passes signal: undefined to Repository.open() when no requestId is given (existing, non-cancellable behavior unchanged)", async () => {
    const openMock = vi.mocked(Repository.open);
    openMock.mockResolvedValueOnce(fakeRepo("/repoA"));

    const session = new RepoSession();
    await session.open("/repoA");

    expect(openMock).toHaveBeenCalledWith("/repoA", { signal: undefined });
  });

  it("threads a fresh AbortController's signal into Repository.open() when a requestId is given, and cancelOpen(requestId) aborts exactly that signal", async () => {
    const openMock = vi.mocked(Repository.open);
    const pending = deferred<Awaited<ReturnType<typeof Repository.open>>>();
    openMock.mockReturnValueOnce(pending.promise);

    const session = new RepoSession();
    const openPromise = session.open("/repoA", "req-1");

    expect(openMock).toHaveBeenCalledTimes(1);
    const passedOptions = openMock.mock.calls[0]![1] as { signal?: AbortSignal } | undefined;
    const signal = passedOptions?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);

    session.cancelOpen("req-1");
    expect(signal!.aborted).toBe(true);

    // Settle the underlying (mocked) Repository.open() call so the test doesn't leave a dangling
    // unresolved promise — real git-core's own OperationCancelledError behavior on a real aborted
    // signal is covered by packages/git-core's own test suite, not re-tested here.
    pending.resolve(fakeRepo("/repoA"));
    await openPromise;
  });

  it("cancelOpen() with an unknown requestId is a harmless no-op — never throws, never affects any other in-flight open", async () => {
    const openMock = vi.mocked(Repository.open);
    openMock.mockResolvedValueOnce(fakeRepo("/repoA"));

    const session = new RepoSession();
    expect(() => session.cancelOpen("never-existed")).not.toThrow();
    await session.open("/repoA", "req-1");
    // Already settled — calling cancelOpen for it now must be a no-op, not affect anything.
    expect(() => session.cancelOpen("req-1")).not.toThrow();
  });

  it("the AbortController for a requestId is cleaned up once its open() settles — a later open() reusing the same requestId gets its OWN fresh, independent controller", async () => {
    const openMock = vi.mocked(Repository.open);
    openMock.mockResolvedValueOnce(fakeRepo("/repoA")).mockResolvedValueOnce(fakeRepo("/repoB"));

    const session = new RepoSession();
    await session.open("/repoA", "req-1");
    const firstSignal = (openMock.mock.calls[0]![1] as { signal?: AbortSignal }).signal!;

    await session.open("/repoB", "req-1"); // same requestId, reused after the first settled
    const secondSignal = (openMock.mock.calls[1]![1] as { signal?: AbortSignal }).signal!;

    expect(secondSignal).not.toBe(firstSignal);
    // Cancelling "req-1" now only affects whatever is CURRENTLY registered under it — since both
    // already settled, this is a no-op either way, but must not throw or resurrect the first one.
    expect(() => session.cancelOpen("req-1")).not.toThrow();
    expect(firstSignal.aborted).toBe(false);
    expect(secondSignal.aborted).toBe(false);
  });

  it("dispose() aborts every still in-flight open()'s signal — no window-close orphan (FR-164)", async () => {
    const openMock = vi.mocked(Repository.open);
    const pending = deferred<Awaited<ReturnType<typeof Repository.open>>>();
    openMock.mockReturnValueOnce(pending.promise);

    const session = new RepoSession();
    void session.open("/repoA", "req-1");
    const signal = (openMock.mock.calls[0]![1] as { signal?: AbortSignal }).signal!;
    expect(signal.aborted).toBe(false);

    session.dispose();
    expect(signal.aborted).toBe(true);

    pending.resolve(fakeRepo("/repoA")); // let the mocked call settle so it doesn't dangle
  });

  // security review (specs/repo-list.md, revised IA): the concrete gap that report flagged —
  // `newTab()`/closing the last tab called `graph.closeRepo()`, which only closed the renderer's
  // own commit-log readers (`api.closeReader`) — there was no way to tell the main-process
  // `RepoSession` to actually close its `fs.watch` handle short of a brand-new `open()` call or
  // the whole window closing. These prove `dispose()` (now reachable via the `closeRepoSession`
  // IPC channel `main.ts` registers) genuinely closes the watcher and clears the live repo, not
  // just the in-flight-open abort behavior the sibling test above already covered.
  it("dispose() closes the active ref-change watcher, not just in-flight opens", async () => {
    const openMock = vi.mocked(Repository.open);
    const { repo, watcherClose } = fakeRepoWithWatcher("/repoA");
    openMock.mockResolvedValueOnce(repo);

    const session = new RepoSession();
    await session.open("/repoA");
    session.startWatch(() => {});
    expect(watcherClose).not.toHaveBeenCalled();

    session.dispose();
    expect(watcherClose).toHaveBeenCalledTimes(1);
  });

  it("dispose() clears the live repo — getOpenRepo() throws afterward, exactly like before any repo was ever opened", async () => {
    const openMock = vi.mocked(Repository.open);
    openMock.mockResolvedValueOnce(fakeRepo("/repoA"));

    const session = new RepoSession();
    await session.open("/repoA");
    expect(session.getOpenRepo()).toBeDefined();

    session.dispose();
    expect(() => session.getOpenRepo()).toThrow(/no repository is open/i);
  });

  it("dispose() closes every open commit-log reader (mirrors the individual closeReader teardown, in one call)", async () => {
    const openMock = vi.mocked(Repository.open);
    openMock.mockResolvedValueOnce(fakeRepo("/repoA"));

    const session = new RepoSession();
    await session.open("/repoA");
    const readerClose = vi.fn();
    const readerId = session.createReader({ close: readerClose } as unknown as Parameters<typeof session.createReader>[0]);

    session.dispose();
    expect(readerClose).toHaveBeenCalledTimes(1);
    expect(() => session.getReader(readerId)).toThrow(/unknown commit log reader/i);
  });
});
