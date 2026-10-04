// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * specs/live-refresh.md FR-459: debounced, coalesced runner. A burst of `request()`s collapses into one run after
 * `debounceMs` (but never later than `maxWaitMs` after the first); a request that lands while a run is in flight sets exactly one trailing run, never a queue.
 */
export interface CoalescedRunner {
  request(): void;
  cancel(): void;
}

export function createCoalescedRunner(
  run: () => Promise<void>,
  debounceMs: number,
  maxWaitMs = 1000,
): CoalescedRunner {
  let firstPendingAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let trailing = false;
  let cancelled = false;

  const start = async (): Promise<void> => {
    if (cancelled) return;
    if (inFlight) {
      trailing = true;
      return;
    }
    inFlight = true;
    try {
      await run();
    } catch {
      // `run` owns its error reporting; a throw must not wedge the in-flight flag.
    } finally {
      inFlight = false;
    }
    if (trailing && !cancelled) {
      trailing = false;
      void start();
    }
  };

  return {
    request() {
      if (cancelled) return;
      // Max-wait: a continuous event stream must not starve the run (security review L1).
      const now = Date.now();
      if (timer) clearTimeout(timer);
      else firstPendingAt = now;
      const wait = Math.max(0, Math.min(debounceMs, firstPendingAt + maxWaitMs - now));
      timer = setTimeout(() => {
        timer = null;
        void start();
      }, wait);
    },
    cancel() {
      cancelled = true;
      trailing = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
