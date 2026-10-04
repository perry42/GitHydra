// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * specs/live-refresh.md FR-459: debounced, coalesced runner. A burst of `request()`s collapses into one run after
 * `debounceMs`; a request that lands while a run is in flight sets exactly one trailing run, never a queue.
 */
export interface CoalescedRunner {
  request(): void;
  cancel(): void;
}

export function createCoalescedRunner(run: () => Promise<void>, debounceMs: number): CoalescedRunner {
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
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void start();
      }, debounceMs);
    },
    cancel() {
      cancelled = true;
      trailing = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
