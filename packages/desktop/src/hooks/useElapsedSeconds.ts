// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from "react";

/**
 * specs/repo-open-feedback.md FR-166/AC1/AC6: whole seconds elapsed since `active` most recently
 * became `true`, ticking at least once per second for as long as `active` stays `true`, and
 * resetting to `0` the instant it does (no minimum artificial display duration — a caller that
 * flips back to inactive before the first tick simply never showed a nonzero value, satisfying
 * AC6's "fast open may appear only briefly or not at all").
 *
 * `resetKey` covers the case `active` itself can't: `MainArea`'s `graph.status === "opening"`
 * branch stays mounted (and `active` stays `true` the whole time) across a rapid re-open that
 * supersedes an already-in-flight attempt — `useRepositoryGraph.openRepo` sets `status` to
 * `"opening"` again on every call, generation bump or not, so there's no `false -> true` edge to
 * key a reset off. Passing `graph.openSequence` (bumped on every `openRepo` call regardless of
 * outcome — see its own doc comment in `useRepositoryGraph.ts`) as `resetKey` forces the clock back
 * to 0 for the new attempt too, so a stale timer from the superseded attempt never bleeds into it.
 */
export function useElapsedSeconds(active: boolean, resetKey: unknown): number {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    setSeconds(0);
    const start = Date.now();
    const id = setInterval(() => {
      setSeconds(Math.max(0, Math.round((Date.now() - start) / 1000)));
    }, 1000);
    return () => clearInterval(id);
    // Deliberately re-running (and thus restarting the clock) on `resetKey` changing, not just on
    // `active`'s own transitions — see doc comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, resetKey]);

  return seconds;
}
