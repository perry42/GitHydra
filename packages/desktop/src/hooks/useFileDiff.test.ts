// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { FileDiffResult } from "@githydra/git-core";
import { useFileDiff } from "./useFileDiff";

const diff = (n: number): FileDiffResult => ({ status: "ok", isBinary: false, hunks: [], fingerprint: `fp-${n}` });

// specs/hunk-line-staging.md FR-454: `reload` swaps the result in place (scroll must survive).
describe("useFileDiff.reload", () => {
  it("goes ready -> ready without passing through loading", async () => {
    const { result } = renderHook(() => useFileDiff());
    await act(async () => result.current.load("unstaged:a", async () => ({ ok: true, data: diff(1) })));
    const seen: string[] = [];
    let pending: Promise<FileDiffResult | null> | undefined;
    await act(async () => {
      pending = result.current.reload("unstaged:a", async () => {
        seen.push(result.current.state.status);
        return { ok: true, data: diff(2) };
      });
      await pending;
    });
    expect(seen).toEqual(["ready"]);
    expect(result.current.state).toMatchObject({ status: "ready", result: { fingerprint: "fp-2" } });
  });

  it("drops a superseded reload and resolves null", async () => {
    const { result } = renderHook(() => useFileDiff());
    let releaseFirst: () => void = () => {};
    const first = new Promise<void>((r) => (releaseFirst = r));
    let firstResult: FileDiffResult | null = diff(0);
    await act(async () => {
      const p1 = result.current.reload("k", async () => {
        await first;
        return { ok: true, data: diff(1) };
      });
      await result.current.reload("k", async () => ({ ok: true, data: diff(2) }));
      releaseFirst();
      firstResult = await p1;
    });
    expect(firstResult).toBeNull();
    expect(result.current.state).toMatchObject({ status: "ready", result: { fingerprint: "fp-2" } });
  });

  it("moves to error on failure and resolves null", async () => {
    const { result } = renderHook(() => useFileDiff());
    let value: FileDiffResult | null = diff(0);
    await act(async () => {
      value = await result.current.reload("k", async () => ({ ok: false, error: { name: "GitCommandError", message: "boom" } }));
    });
    expect(value).toBeNull();
    expect(result.current.state).toMatchObject({ status: "error", message: "boom" });
  });
});
