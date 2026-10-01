// SPDX-License-Identifier: GPL-3.0-or-later
// specs/hunk-line-staging.md FR-454: git failures from a hunk/line action get a one-line human summary,
// with the full (flag-stripped) stderr kept for a "Show details" disclosure.
export type PartialVerb = "stage" | "unstage" | "discard";

export interface PartialFailure {
  summary: string;
  details: string;
}

// git-core injects hardening flags (`-c core.fsmonitor=false -c core.hooksPath=...`); they are noise to a user.
export function stripInjectedFlags(message: string): string {
  return message
    .replace(/(^|\s)-c\s+[\w.]+=\S*/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^\s+/, "");
}

export function summarizePartialFailure(verb: PartialVerb, rawMessage: string): PartialFailure {
  const details = stripInjectedFlags(rawMessage).trim();
  if (/index\.lock/.test(details)) {
    return { summary: `Couldn't ${verb}: another git process holds index.lock`, details };
  }
  // Prefer git's own words (after "exited with code N:") over the echoed command line.
  const afterExit = /exited with code \d+:\s*([\s\S]*)$/.exec(details);
  const body = (afterExit ? afterExit[1]! : details).trim();
  const firstLine = (body.split(/\r?\n/).find((l) => l.trim().length > 0) ?? details).replace(/^(fatal|error):\s*/i, "").trim();
  return { summary: `Couldn't ${verb} the selection: ${firstLine}`, details };
}
