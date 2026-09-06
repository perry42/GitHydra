// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useImageDiff } from "./useImageDiff";
import type { ImageDiffResult } from "@githydra/git-core";
import type { IpcResult } from "../../shared/ipcContract";

function ok<T>(data: T): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: true, data });
}

const addedResult: ImageDiffResult = {
  status: "ok",
  old: null,
  new: { base64: "abc123", byteSize: 3, mimeType: "image/png" },
};

describe("useImageDiff (specs/image-diff-preview.md FR-144)", () => {
  it("starts idle", () => {
    const { result } = renderHook(() => useImageDiff());
    expect(result.current.state).toEqual({ status: "idle" });
  });

  it("transitions loading -> ready with the resolved image diff", async () => {
    const { result } = renderHook(() => useImageDiff());
    act(() => {
      result.current.load("unstaged:a.png", () => ok(addedResult));
    });
    expect(result.current.state.status).toBe("loading");
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(result.current.state).toEqual({ status: "ready", key: "unstaged:a.png", result: addedResult });
  });

  it("transitions loading -> error on an IPC failure (FR-147)", async () => {
    const { result } = renderHook(() => useImageDiff());
    act(() => {
      result.current.load("unstaged:a.png", () =>
        Promise.resolve({ ok: false, error: { name: "GitCommandError", message: "boom" } }),
      );
    });
    await waitFor(() => expect(result.current.state.status).toBe("error"));
    expect(result.current.state).toMatchObject({ status: "error", key: "unstaged:a.png", message: "boom" });
  });

  it("drops a stale response from a superseded load() call", async () => {
    const { result } = renderHook(() => useImageDiff());
    let resolveFirst!: (value: IpcResult<ImageDiffResult>) => void;
    act(() => {
      result.current.load("a.png", () => new Promise((resolve) => (resolveFirst = resolve)));
    });
    act(() => {
      result.current.load("b.png", () => ok(addedResult));
    });
    await waitFor(() => expect(result.current.state).toEqual({ status: "ready", key: "b.png", result: addedResult }));

    act(() => resolveFirst({ ok: true, data: addedResult }));
    // The first load's late resolution must not clobber the second, newer selection.
    expect(result.current.state).toEqual({ status: "ready", key: "b.png", result: addedResult });
  });

  it("clear() returns to idle and invalidates any in-flight load", async () => {
    const { result } = renderHook(() => useImageDiff());
    act(() => {
      result.current.load("a.png", () => ok(addedResult));
    });
    act(() => {
      result.current.clear();
    });
    expect(result.current.state).toEqual({ status: "idle" });
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.state).toEqual({ status: "idle" });
  });
});
