// SPDX-License-Identifier: GPL-3.0-or-later
// specs/edit-in-diff.md FR-535 (M1): the main-process half of "closing the app never drops an unsaved edit silently".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloseGuard } from "./closeGuard";

function setup(confirmUnresponsive: () => Promise<boolean> = async () => false) {
  const calls = { request: 0, closeNow: [] as { quit: boolean }[], confirm: 0 };
  const guard = createCloseGuard({
    requestClose: () => void (calls.request += 1),
    closeNow: (o) => void calls.closeNow.push(o),
    confirmUnresponsive: async () => {
      calls.confirm += 1;
      return confirmUnresponsive();
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    ackTimeoutMs: 5000,
  });
  const close = () => {
    const ev = { prevented: false, preventDefault() { this.prevented = true; } };
    guard.onWindowClose(ev);
    return ev;
  };
  return { guard, calls, close };
}

describe("close guard (FR-535)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("lets a clean window close immediately, with no request", () => {
    const { calls, close } = setup();
    expect(close().prevented).toBe(false);
    expect(calls.request).toBe(0);
  });

  it("prevents the close and asks the renderer when the buffer is dirty", () => {
    const { guard, calls, close } = setup();
    guard.setDirty(true);
    expect(close().prevented).toBe(true);
    expect(calls.request).toBe(1);
    expect(calls.closeNow).toEqual([]);
  });

  it("closes only after the renderer answers allow, and that close is not intercepted again", () => {
    const { guard, calls, close } = setup();
    guard.setDirty(true);
    close();
    guard.onReply("allow");
    expect(calls.closeNow).toEqual([{ quit: false }]);
    expect(close().prevented).toBe(false);
  });

  it("stays open on cancel, and a later close asks again", () => {
    const { guard, calls, close } = setup();
    guard.setDirty(true);
    close();
    guard.onReply("cancel");
    expect(calls.closeNow).toEqual([]);
    expect(close().prevented).toBe(true);
    expect(calls.request).toBe(2);
  });

  it("ignores an allow that nobody asked for, so a stray reply can never close the window", () => {
    const { guard, calls } = setup();
    guard.setDirty(true);
    guard.onReply("allow");
    expect(calls.closeNow).toEqual([]);
  });

  it("refuses a non-boolean dirty value and keeps the previous state", () => {
    const { guard, close } = setup();
    guard.setDirty(true);
    guard.setDirty("false");
    guard.setDirty(undefined);
    expect(close().prevented).toBe(true);
    guard.setDirty(false);
    guard.onReply("cancel");
    expect(close().prevented).toBe(false);
  });

  it("completes the quit that a prevented close cancelled (Cmd+Q)", () => {
    const { guard, calls, close } = setup();
    guard.setDirty(true);
    guard.noteQuitRequested();
    close();
    guard.onReply("allow");
    expect(calls.closeNow).toEqual([{ quit: true }]);
  });

  it("still offers the way out when sending the request throws", async () => {
    const calls = { confirm: 0 };
    const guard = createCloseGuard({
      requestClose: () => {
        throw new Error("destroyed");
      },
      closeNow: () => {},
      confirmUnresponsive: async () => (calls.confirm++, false),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ackTimeoutMs: 5000,
    });
    guard.setDirty(true);
    guard.onWindowClose({ preventDefault() {} });
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.confirm).toBe(1);
  });

  it("a cancelled quit does not turn a later plain close into a quit", () => {
    const { guard, calls, close } = setup();
    guard.setDirty(true);
    guard.noteQuitRequested();
    close();
    guard.onReply("cancel");
    close();
    guard.onReply("allow");
    expect(calls.closeNow).toEqual([{ quit: false }]);
  });

  describe("a renderer that does not answer", () => {
    it("offers the native confirm after 5 s, and closes only if the user says close anyway", async () => {
      const { guard, calls, close } = setup(async () => true);
      guard.setDirty(true);
      close();
      await vi.advanceTimersByTimeAsync(4999);
      expect(calls.confirm).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls.confirm).toBe(1);
      expect(calls.closeNow).toEqual([{ quit: false }]);
    });

    it("keeps the window open when the user picks Keep open", async () => {
      const { guard, calls, close } = setup(async () => false);
      guard.setDirty(true);
      close();
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls.confirm).toBe(1);
      expect(calls.closeNow).toEqual([]);
      expect(close().prevented).toBe(true);
    });

    it("a prompting acknowledgement stops the hang timer, so a user reading the dialog is never rushed", async () => {
      const { guard, calls, close } = setup();
      guard.setDirty(true);
      close();
      guard.onReply("prompting");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls.confirm).toBe(0);
      guard.onReply("allow");
      expect(calls.closeNow).toHaveLength(1);
    });

    it("a second close attempt while a request is open goes straight to the native confirm, even if the renderer keeps saying prompting", async () => {
      const { guard, calls, close } = setup(async () => true);
      guard.setDirty(true);
      close();
      guard.onReply("prompting");
      const second = close();
      expect(second.prevented).toBe(true);
      guard.onReply("prompting");
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.confirm).toBe(1);
      expect(calls.request).toBe(1);
      expect(calls.closeNow).toHaveLength(1);
    });

    it("Cmd+Q on a second attempt reaches the same fallback and completes the quit", async () => {
      const { guard, calls, close } = setup(async () => true);
      guard.setDirty(true);
      close();
      guard.onReply("prompting");
      guard.noteQuitRequested();
      close();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.closeNow).toEqual([{ quit: true }]);
    });

    it("Keep open clears a pending quit, so the next plain close is a plain close", async () => {
      const answers = [false, true];
      const { guard, calls, close } = setup(async () => answers.shift()!);
      guard.setDirty(true);
      guard.noteQuitRequested();
      close();
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls.closeNow).toEqual([]);
      close();
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls.closeNow).toEqual([{ quit: false }]);
    });

    it("the OS reporting the renderer unresponsive skips the wait", async () => {
      const { guard, calls, close } = setup(async () => true);
      guard.setDirty(true);
      close();
      guard.onReply("prompting");
      guard.rendererUnresponsive();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.confirm).toBe(1);
    });

    it("a crashed or reloaded renderer has no buffer left to protect", () => {
      const { guard, close } = setup();
      guard.setDirty(true);
      guard.rendererGone();
      expect(close().prevented).toBe(false);
    });
  });

  it("a before-quit that no close follows expires, so a later close is not a quit", async () => {
    const { guard, calls, close } = setup();
    guard.setDirty(true);
    guard.noteQuitRequested();
    await vi.advanceTimersByTimeAsync(2500);
    close();
    guard.onReply("allow");
    expect(calls.closeNow).toEqual([{ quit: false }]);
  });

  it("a renderer crash clears a pending quit", () => {
    const { guard, calls, close } = setup();
    guard.setDirty(true);
    guard.noteQuitRequested();
    guard.rendererGone();
    guard.setDirty(true);
    close();
    guard.onReply("allow");
    expect(calls.closeNow).toEqual([{ quit: false }]);
  });

  it("an allowed close that did not complete is guarded again after a short delay", async () => {
    const { guard, close } = setup();
    guard.setDirty(true);
    close();
    guard.onReply("allow");
    expect(close().prevented).toBe(false);
    await vi.advanceTimersByTimeAsync(3500);
    expect(close().prevented).toBe(true);
  });

  it("never vetoes a session end (logoff, shutdown, restart), even with a dirty buffer or an open request", () => {
    const { guard, calls, close } = setup();
    guard.setDirty(true);
    close();
    guard.sessionEnding();
    expect(close().prevented).toBe(false);
    expect(calls.closeNow).toEqual([]);
  });

  it("a query-session-end that never becomes a real shutdown stops allowing closes after ~30 s", async () => {
    const { guard, close } = setup();
    guard.setDirty(true);
    guard.sessionEnding();
    expect(close().prevented).toBe(false);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(close().prevented).toBe(true);
  });

  it("a final session end (session-end, shutdown) never resets", async () => {
    const { guard, close } = setup();
    guard.setDirty(true);
    guard.sessionEnding({ final: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(close().prevented).toBe(false);
  });

  it("if closeNow throws, the allow still resets", async () => {
    const guard = createCloseGuard({
      requestClose: () => {},
      closeNow: () => {
        throw new Error("boom");
      },
      confirmUnresponsive: async () => false,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ackTimeoutMs: 5000,
    });
    const ev = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
    guard.setDirty(true);
    guard.onWindowClose(ev());
    expect(() => guard.onReply("allow")).toThrow();
    await vi.advanceTimersByTimeAsync(3500);
    const e = ev();
    guard.onWindowClose(e);
    expect(e.prevented).toBe(true);
  });
});
