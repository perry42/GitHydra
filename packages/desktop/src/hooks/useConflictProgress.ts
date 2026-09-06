// SPDX-License-Identifier: GPL-3.0-or-later
import { useRef } from "react";

export interface ConflictProgress {
  /** Live remaining conflict count, straight from the caller — never re-derived here. */
  remaining: number;
  /** How many of this operation's conflicts have been resolved so far. */
  resolved: number;
  /** The highest conflict count observed since the current operation started. */
  total: number;
}

/**
 * FR-67: "N of M conflicts resolved" — computed entirely from the live conflicted-file count
 * (`WorkingDirectoryChanges.conflicted.length` / `getConflictedFiles().length`), never a
 * separately-tracked "user clicked resolve" flag that could drift from git's actual state.
 *
 * The only thing held in memory here is `M` (the ceiling used to compute "resolved so far") — not
 * a per-file resolved flag. `M` is captured as the highest live count seen since the current
 * operation began (`operationActive` transitioning false -> true resets it), and is bumped back up
 * if the live count ever exceeds it (e.g. a multi-step rebase surfacing new conflicts on its next
 * step) — so a bad initial read never makes the count go negative or get stuck stale. When no
 * operation is in progress, this returns all-zero progress rather than a stale leftover count.
 */
export function useConflictProgress(remaining: number, operationActive: boolean): ConflictProgress {
  const totalRef = useRef(0);
  const wasActiveRef = useRef(false);

  if (!operationActive) {
    wasActiveRef.current = false;
    totalRef.current = 0;
    return { remaining: 0, resolved: 0, total: 0 };
  }

  if (!wasActiveRef.current) {
    // A fresh operation just started (or this is the first render while one is active) — the
    // live count observed right now is the starting ceiling.
    wasActiveRef.current = true;
    totalRef.current = remaining;
  } else if (remaining > totalRef.current) {
    totalRef.current = remaining;
  }

  const total = totalRef.current;
  const resolved = Math.max(0, total - remaining);
  return { remaining, resolved, total };
}
