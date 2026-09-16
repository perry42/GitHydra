// SPDX-License-Identifier: GPL-3.0-or-later
import { redactGitCredentials } from "./credentialRedaction";
import type { ClassifiedGitNetworkError, GitNetworkErrorKind } from "./types";

/**
 * specs/online-sync-fetch.md FR-323: classify a failed network git command's stderr (from
 * `fetch`/later `pull`/`push`/`clone`) into `GitNetworkErrorKind`'s closed set. A pure function —
 * takes the raw stderr text a caller already has (e.g. `GitCommandError.stderr`), does not itself
 * run git or know anything about which command failed.
 *
 * Every pattern below was verified against REAL git output (git 2.31.1.windows.1, 2026-09-16),
 * provoked from real local fixture repos and a handful of genuine outbound attempts against real,
 * well-known hosts (github.com, bitbucket.org, gitlab.com) with credentials/keys deliberately
 * withheld or invalidated — never guessed from documentation. See each rule's own comment for
 * the exact observed string.
 *
 * One thing observed while researching these strings is deliberately NOT encoded as a
 * classification rule here, because it isn't a stderr-shape problem this module can fix at all: a
 * real git-credential-manager-style HELPER (as opposed to git's own terminal-prompt fallback) may
 * legitimately prompt a real user — via its own GUI dialog — before a command reaches the point of
 * producing any of the stderr shapes classified below. `fetch.ts`'s `fetchRemote()` used to disable
 * that helper unconditionally to force a fast, classifiable failure instead (FR-325); that was
 * reverted (see `gitProcess.ts`'s history at the removed `withCredentialHelperNeutralized()`) once
 * direct observation showed the "hang" it worked around was actually a real GUI prompt a real user
 * would simply answer, and disabling the helper broke authentication entirely. This module only
 * ever classifies stderr from a command that has ALREADY exited (whether or not a credential
 * prompt was involved along the way) — it has no opinion on, and no ability to change, whether or
 * how quickly that happens.
 *
 * `fatal: repository '<url>' not found` (a real, observed GitHub/Bitbucket message for both a
 * genuinely nonexistent remote AND a private repo the caller can't see — both hosts return the
 * same 404-shaped response either way, to avoid leaking whether a private repo exists) was
 * originally left to fall through to `"unknown"` here, flagged to product-manager as a real gap
 * (this is one of the single most common real-world fetch failures — a typo'd remote, or a
 * since-deleted/renamed repo — and `"unknown"` is honest but not especially actionable for it).
 * Per that product decision, it is now its own rule (`"repository-not-found"`, below), whose
 * message honestly names both possibilities rather than guessing one.
 */

interface ClassificationRule {
  kind: GitNetworkErrorKind;
  pattern: RegExp;
  message: string;
}

const RULES: readonly ClassificationRule[] = [
  {
    // Verified: `git@github.com: Permission denied (publickey).` — the terminal line OpenSSH
    // prints when every key offered (agent + any explicitly configured IdentityFile) was
    // refused by the remote. OpenSSH's own wording can list more than one failed method in the
    // parenthesized list (e.g. "(publickey,password)") when other methods were also attempted
    // and failed, so this matches on the leading "(publickey" prefix rather than the full exact
    // parenthesized contents.
    kind: "ssh-key-rejected",
    pattern: /Permission denied \(publickey/i,
    message:
      "The remote rejected every SSH key offered. Check that your SSH agent is running with " +
      "the right key loaded (try `ssh-add -l`), and that the matching public key is registered " +
      "with your git host. GitHydra does not store or manage SSH keys — this is your system's " +
      "own SSH configuration to fix.",
  },
  {
    // Verified two real shapes, both ending in this exact line: a never-before-seen host in
    // strict mode ("No ED25519 host key is known for github.com and you have requested strict
    // checking.\nHost key verification failed."), and (by OpenSSH's documented behavior, not
    // independently reproduced here) a changed-host-key MITM-shaped warning, which ends the
    // same way.
    kind: "host-key-verification-failed",
    pattern: /Host key verification failed/i,
    message:
      "The remote's SSH host key could not be verified. If you recently changed hosting " +
      "providers, verify the new host key out-of-band before trusting it. Otherwise, connect " +
      "once from a terminal (`ssh <host>`) or check your `~/.ssh/known_hosts` file yourself — " +
      "GitHydra never overrides SSH host-key trust decisions.",
  },
  {
    // Verified three real shapes: `fatal: could not read Username for 'https://bitbucket.org': terminal
    // prompts disabled` (no credential helper configured AND no interactive terminal prompt
    // available — the exact situation `GIT_TERMINAL_PROMPT=0` produces when no helper ever runs at
    // all); `fatal: Authentication failed for 'https://github.com/.../...git/'` (credentials WERE
    // supplied — e.g. from the user's own credential helper, possibly after that helper's own GUI
    // prompt was shown and answered, or embedded directly in the URL — but the host rejected them);
    // and the `remote: Invalid username or token...`/`remote: HTTP Basic: Access denied` lines hosts
    // commonly print immediately before that fatal line (GitLab's "HTTP Basic: Access denied"
    // wording itself is a well-known, widely-documented message, not independently reproduced here
    // — included defensively since it is the same failure class).
    //
    // security-review item 3 (2026-09-16): this message points at "your git credential helper"
    // deliberately — `fetch.ts`'s `fetchRemote()` no longer disables it (see FR-325's reversal,
    // `gitProcess.ts`), so a real GUI/terminal credential helper genuinely IS the live mechanism a
    // user should check here, exactly as this message says. This reached the wrong conclusion once
    // already (when the helper WAS disabled by this codebase, pointing at it would have been
    // actively misleading) — kept honest here by staying in sync with `fetchRemote()`'s actual
    // behavior rather than being written once and assumed still true.
    kind: "https-auth-failed",
    pattern:
      /(Authentication failed for|could not read (Username|Password) for|HTTP Basic: Access denied|Invalid username or (password|token))/i,
    message:
      "HTTPS authentication failed, or no credentials were available at all. If a credential " +
      "prompt appeared, check that you answered it correctly. Otherwise check your git " +
      "credential helper (`git config --get credential.helper`) and, if your host uses personal " +
      "access tokens, confirm yours hasn't expired. GitHydra never stores or prompts for " +
      "credentials itself — this is entirely your system git's own credential helper and SSH " +
      "agent configuration.",
  },
  {
    // Verified four real shapes: `fatal: unable to access '<url>': Could not resolve host: <host>`
    // and `...Failed to connect to <host> port <port>: Connection refused` (HTTPS/libcurl), plus
    // `ssh: Could not resolve hostname <host>: Name or service not known` and `ssh: connect to
    // host <host> port <port>: Connection timed out` (SSH/OpenSSH, both followed by git's own
    // generic `fatal: Could not read from remote repository.` — that generic closing line is
    // deliberately NOT matched on its own, since it is also what an SSH key rejection or a host-key
    // failure both produce; only the specific cause line above it is diagnostic).
    kind: "host-unreachable",
    pattern:
      /(Could not resolve host|Could not resolve hostname|Failed to connect to|Connection refused|Connection timed out|Network is unreachable|No route to host)/i,
    message:
      "Could not reach the remote host. Check your network connection and the remote's URL " +
      "(`git remote -v`) — the host may be down, or the address may be wrong.",
  },
  {
    // Verified: `fatal: repository 'https://github.com/.../....git/' not found` — reproduced
    // directly (2026-09-16) fetching a deliberately nonexistent GitHub path. GitHub and Bitbucket
    // both document returning this same message/status for a genuinely missing repo AND for a
    // private one the caller's credentials can't see, specifically to avoid confirming a private
    // repo's existence to someone without access — so this module has no reliable way (and no
    // business guessing) which of the two actually happened.
    kind: "repository-not-found",
    pattern: /repository '.*' not found/i,
    message:
      "Check the URL is correct — or, if the repository is private, that your credentials have " +
      "access to it. Hosts like GitHub and Bitbucket report both cases identically to avoid " +
      "revealing whether a private repository exists.",
  },
];

const UNKNOWN_MESSAGE =
  "The git network operation failed for a reason GitHydra doesn't recognize. See the details " +
  "below for git's own output.";

/**
 * FR-323: classify `stderr` (from a failed network git command) into `GitNetworkErrorKind`'s
 * closed set. `rawStderr` on the result is ALWAYS `stderr` after `redactGitCredentials()` (FR-324)
 * — the raw, unredacted string is never returned from this function under any outcome, including
 * `"unknown"`, where preserving the (redacted) original text is the entire value of the result.
 */
export function classifyGitNetworkError(stderr: string): ClassifiedGitNetworkError {
  const rawStderr = redactGitCredentials(stderr);
  for (const rule of RULES) {
    if (rule.pattern.test(rawStderr)) {
      return { kind: rule.kind, message: rule.message, rawStderr };
    }
  }
  return { kind: "unknown", message: UNKNOWN_MESSAGE, rawStderr };
}
