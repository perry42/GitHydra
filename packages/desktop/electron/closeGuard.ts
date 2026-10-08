// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * specs/edit-in-diff.md FR-535 (ship gate M1): closing the app with an unsaved editor buffer must ask first. The renderer
 * owns the buffer, so main only intercepts the window's `close`, asks the renderer over two typed channels, and closes
 * when told to. Kept free of Electron imports so the state machine is unit-testable.
 */

export type CloseReply = "allow" | "cancel" | "prompting";

export interface CloseGuardDeps {
  /** Sends the typed `close-requested` event to the renderer. */
  requestClose(): void;
  /** Really closes. `quit`: the user asked to quit the app (Cmd+Q), whose quit the prevented close had cancelled. */
  closeNow(opts: { quit: boolean }): void;
  /** Native confirm for a renderer that never answered. Resolves true to close anyway. */
  confirmUnresponsive(): Promise<boolean>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** How long the renderer has to acknowledge a request before it is treated as hung. */
  ackTimeoutMs: number;
}

export interface CloseGuard {
  /** `ipc: setEditDirty`. Validates: anything but a boolean is refused (and leaves the state as it was). */
  setDirty(value: unknown): void;
  /** The window's `close` event. Prevents the close when a dirty buffer needs asking about. */
  onWindowClose(event: { preventDefault(): void }): void;
  /** `ipc: confirmClose`. Replies outside an open request are ignored, so a stray reply can never close the window. */
  onReply(value: unknown): void;
  /** The renderer is gone (crash, reload): its buffer no longer exists, so there is nothing to protect. */
  rendererGone(): void;
  /** The OS reports the renderer as unresponsive: skip the wait and offer the native fallback now. */
  rendererUnresponsive(): void;
  /** `before-quit` (Cmd+Q, app menu): after an allowed close, finish the quit that the prevented close cancelled (specs/edit-in-diff.md FR-535). */
  noteQuitRequested(): void;
  /** Windows logoff/shutdown/restart (and Linux/macOS `shutdown`): never veto it; a veto only yields a "blocked shutdown" screen and the buffer is lost anyway. */
  sessionEnding(opts?: { final?: boolean }): void;
  dispose(): void;
}

export const CLOSE_ACK_TIMEOUT_MS = 5000;
const ALLOWED_RESET_MS = 3000;
const SESSION_QUERY_ALLOW_MS = 30_000;
// A before-quit that no window close follows (quit cancelled elsewhere) must not turn a later plain close into a quit.
const QUIT_FLAG_TTL_MS = 2000;

export function createCloseGuard(deps: CloseGuardDeps): CloseGuard {
  let dirty = false;
  let asking = false;
  let allowed = false;
  let quitRequested = false;
  let timer: unknown = null;
  let fallbackOpen = false;
  let quitTimer: unknown = null;
  let allowedTimer: unknown = null;

  const stopTimer = () => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };
  const armTimer = () => {
    stopTimer();
    timer = deps.setTimer(() => {
      timer = null;
      void offerNativeFallback();
    }, deps.ackTimeoutMs);
  };
  const clearQuitTimer = () => {
    if (quitTimer !== null) deps.clearTimer(quitTimer);
    quitTimer = null;
  };
  // If the close did not complete (something else vetoed it, or the shutdown was cancelled), guard again afterwards.
  const armAllowedReset = (ms: number) => {
    if (allowedTimer !== null) deps.clearTimer(allowedTimer);
    allowedTimer = deps.setTimer(() => {
      allowedTimer = null;
      allowed = false;
    }, ms);
  };
  const finish = () => {
    stopTimer();
    asking = false;
    allowed = true;
    armAllowedReset(ALLOWED_RESET_MS);
    deps.closeNow({ quit: quitRequested });
  };

  // A hung renderer must never make the app unclosable, but silently closing would drop the buffer. So ask natively
  // (main stays responsive): the user decides ("Keep open" is the default), and closing again asks again.
  async function offerNativeFallback(): Promise<void> {
    if (!asking || fallbackOpen) return;
    fallbackOpen = true;
    let closeAnyway = false;
    try {
      closeAnyway = await deps.confirmUnresponsive();
    } catch {
      closeAnyway = false;
    } finally {
      fallbackOpen = false;
    }
    if (!asking) return;
    if (closeAnyway) finish();
    else {
      stopTimer();
      asking = false;
      quitRequested = false;
    }
  }

  return {
    setDirty(value) {
      if (typeof value !== "boolean") return;
      dirty = value;
    },
    onWindowClose(event) {
      clearQuitTimer();
      if (allowed || !dirty) return;
      event.preventDefault();
      // The first attempt is patient (the user may take as long as they like in the dialog). A second one goes straight to
      // the native confirm, so a renderer that keeps answering "prompting" can never make the window unclosable.
      if (asking) {
        void offerNativeFallback();
        return;
      }
      asking = true;
      // Armed first, and a throwing send is survivable: either way the user must still be offered a way out.
      armTimer();
      try {
        deps.requestClose();
      } catch {
        // The timer above still offers the native confirm.
      }
    },
    // A compromised renderer replying "cancel" instantly can always veto a close; that is out of scope (it could also just stay dirty).
    onReply(value) {
      if (!asking) return;
      // Alive and showing the dialog: the user may take as long as they like.
      if (value === "prompting") return stopTimer();
      if (value === "allow") return finish();
      if (value === "cancel") {
        stopTimer();
        asking = false;
        quitRequested = false;
      }
    },
    rendererGone() {
      dirty = false;
      quitRequested = false;
      stopTimer();
      asking = false;
    },
    rendererUnresponsive() {
      if (asking) void offerNativeFallback();
    },
    noteQuitRequested() {
      quitRequested = true;
      clearQuitTimer();
      quitTimer = deps.setTimer(() => {
        quitTimer = null;
        if (!asking) quitRequested = false;
      }, QUIT_FLAG_TTL_MS);
    },
    // `final` (session-end, shutdown) never resets. query-session-end (Windows) fires when the user picks Shut down, which can
    // still be cancelled or blocked, so it only allows for a while.
    sessionEnding(opts) {
      stopTimer();
      asking = false;
      allowed = true;
      if (opts?.final) {
        if (allowedTimer !== null) deps.clearTimer(allowedTimer);
        allowedTimer = null;
      } else armAllowedReset(SESSION_QUERY_ALLOW_MS);
    },
    dispose() {
      stopTimer();
      asking = false;
      dirty = false;
      allowed = false;
      quitRequested = false;
      clearQuitTimer();
      if (allowedTimer !== null) deps.clearTimer(allowedTimer);
      allowedTimer = null;
    },
  };
}
