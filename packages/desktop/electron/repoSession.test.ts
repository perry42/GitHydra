import { describe, expect, it, vi } from "vitest";

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
