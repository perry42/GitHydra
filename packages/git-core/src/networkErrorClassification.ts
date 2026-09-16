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
 * the exact observed string. Two things observed along the way that are NOT encoded as their own
 * rule here (see this function's doc comment continuing below for why):
 *
 *  - A real git-credential-manager-style HELPER (as opposed to git's own terminal-prompt
 *    fallback) can hang indefinitely waiting on a GUI/browser credential prompt that a headless
 *    `child_process.spawn` can never answer — `GIT_TERMINAL_PROMPT=0` (already set by
 *    `gitProcess.ts`'s `safeEnv()`) does NOT suppress this, since it is not a terminal prompt.
 *    Verified directly: a bare `git fetch` against a real host requiring auth, on a machine with
 *    `credential.helper=manager-core` configured, hangs past 20s until the invoking command
 *    explicitly passes `-c credential.helper=` to disable it for that one call. This is a real gap
 *    for whichever future call actually implements `fetchRemote()`/`fetchAllRemotes()`
 *    (FR-320/321) — flagged here since it was discovered as a direct side effect of researching
 *    this function's real stderr strings, but deliberately NOT fixed in this file: this module
 *    only classifies stderr from a command that has already exited, and adding
 *    `-c credential.helper=` to git's own invocation is a `gitProcess.ts`/fetch-implementation
 *    concern, out of scope for the two pure functions this phase builds. Whoever implements
 *    FR-320/321 needs to account for this or FR-323's classifications will rarely be reached at
 *    all in that exact scenario (the process will just hang against `DEFAULT_GIT_TIMEOUT_MS`/the
 *    caller's own `AbortSignal` instead of producing a classifiable stderr).
 *  - `fatal: repository '<url>' not found` (a real, observed GitHub/Bitbucket message for both a
 *    genuinely nonexistent remote AND a private repo the caller can't see — both hosts return the
 *    same 404-shaped response either way, to avoid leaking whether a private repo exists) does not
 *    map cleanly onto any of the five closed outcomes: it is not obviously an auth failure (no
 *    credential was necessarily rejected — the URL/path itself may just be wrong), so it correctly
 *    falls through to `"unknown"` rather than being force-fit into `"https-auth-failed"`. Flagged
 *    to product-manager as a real spec gap: this is one of the single most common real-world fetch
 *    failures (a typo'd remote, or a since-deleted/renamed repo) and it has no home in FR-323's
 *    five-outcome list — `"unknown"` is honest but not especially actionable for what is actually
 *    a very common, easy-to-explain case.
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
    // prompts disabled` (no credential helper AND no interactive prompt available — the exact
    // situation `GIT_TERMINAL_PROMPT=0` produces); `fatal: Authentication failed for
    // 'https://github.com/.../...git/'` (credentials WERE supplied, e.g. embedded in the URL, but
    // the host rejected them); and the `remote: Invalid username or token...`/`remote: HTTP Basic:
    // Access denied` lines hosts commonly print immediately before that fatal line (GitLab's "HTTP
    // Basic: Access denied" wording itself is a well-known, widely-documented message, not
    // independently reproduced here — included defensively since it is the same failure class).
    kind: "https-auth-failed",
    pattern:
      /(Authentication failed for|could not read (Username|Password) for|HTTP Basic: Access denied|Invalid username or (password|token))/i,
    message:
      "HTTPS authentication failed, or no credentials were available at all. Check your git " +
      "credential helper (`git config --get credential.helper`) and, if your host uses personal " +
      "access tokens, confirm yours hasn't expired. GitHydra never stores or prompts for " +
      "credentials — this is entirely your system git's own credential configuration.",
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
