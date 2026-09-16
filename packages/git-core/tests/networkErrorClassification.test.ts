// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { classifyGitNetworkError } from "../src/networkErrorClassification";

/**
 * specs/online-sync-fetch.md FR-323. Every "(real)" fixture string below was captured verbatim
 * from an actual failing `git fetch` invocation (git 2.31.1.windows.1, Windows, 2026-09-16) against
 * real, well-known hosts (github.com, bitbucket.org) or a real local unreachable/refused endpoint —
 * never invented. See `networkErrorClassification.ts`'s own doc comment for the exact commands run
 * and additional context (including two findings noted there that are out of this function's
 * scope: a real credential-helper GUI-hang risk for the future `fetchRemote()` implementation, and
 * "repository not found" not cleanly fitting any of the five outcomes).
 */

describe("classifyGitNetworkError (FR-323)", () => {
  it("classifies a real SSH publickey rejection as ssh-key-rejected", () => {
    // real: `git@github.com: Permission denied (publickey).` followed by git's generic closing
    // lines, provoked via a real fetch against github.com with IdentityFile forced to /dev/null.
    const stderr =
      "git@github.com: Permission denied (publickey).\n" +
      "fatal: Could not read from remote repository.\n\n" +
      "Please make sure you have the correct access rights\n" +
      "and the repository exists.\n";
    const result = classifyGitNetworkError(stderr);
    expect(result.kind).toBe("ssh-key-rejected");
    expect(result.message).toMatch(/ssh agent/i);
    expect(result.message).not.toMatch(/gitHydra (can|will) (fix|store|manage)/i);
  });

  it("classifies a publickey rejection that lists multiple failed auth methods", () => {
    const stderr = "git@example.com: Permission denied (publickey,password).\n";
    expect(classifyGitNetworkError(stderr).kind).toBe("ssh-key-rejected");
  });

  it("classifies a real unknown-host-key strict-mode refusal as host-key-verification-failed", () => {
    // real: provoked via a real fetch against github.com over SSH with UserKnownHostsFile=/dev/null
    // and StrictHostKeyChecking=yes.
    const stderr =
      "No ED25519 host key is known for github.com and you have requested strict checking.\n" +
      "Host key verification failed.\n" +
      "fatal: Could not read from remote repository.\n\n" +
      "Please make sure you have the correct access rights\n" +
      "and the repository exists.\n";
    const result = classifyGitNetworkError(stderr);
    expect(result.kind).toBe("host-key-verification-failed");
    expect(result.message).toMatch(/host key/i);
  });

  it("classifies terminal-prompts-disabled with no credentials available as https-auth-failed", () => {
    // real: `fatal: could not read Username for 'https://bitbucket.org': terminal prompts disabled`
    // — provoked with credential.helper disabled and GIT_TERMINAL_PROMPT=0.
    const stderr = "fatal: could not read Username for 'https://bitbucket.org': terminal prompts disabled\n";
    const result = classifyGitNetworkError(stderr);
    expect(result.kind).toBe("https-auth-failed");
    expect(result.message).toMatch(/credential/i);
  });

  it("classifies a real rejected-credentials HTTPS failure as https-auth-failed", () => {
    // real: provoked via a fetch against github.com with a bad username:token embedded in the URL.
    const stderr =
      "remote: Invalid username or token. Password authentication is not supported for Git operations.\n" +
      "fatal: Authentication failed for 'https://github.com/o/r.git/'\n";
    expect(classifyGitNetworkError(stderr).kind).toBe("https-auth-failed");
  });

  it("classifies GitLab's well-known HTTP Basic: Access denied wording as https-auth-failed", () => {
    // Not independently reproduced against a real GitLab instance this pass — a widely documented,
    // stable GitLab message, included defensively for the same failure class.
    const stderr = "remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://gitlab.com/o/r.git/'\n";
    expect(classifyGitNetworkError(stderr).kind).toBe("https-auth-failed");
  });

  it("classifies a real DNS resolution failure (HTTPS) as host-unreachable", () => {
    // real: `git fetch https://nonexistent-host-xyz-12345.invalid/repo.git`
    const stderr =
      "fatal: unable to access 'https://nonexistent-host-xyz-12345.invalid/repo.git/': " +
      "Could not resolve host: nonexistent-host-xyz-12345.invalid\n";
    const result = classifyGitNetworkError(stderr);
    expect(result.kind).toBe("host-unreachable");
    expect(result.message).toMatch(/network|host/i);
  });

  it("classifies a real connection-refused failure (HTTPS) as host-unreachable", () => {
    // real: `git fetch https://127.0.0.1:9/repo.git` (port 9 = discard, nothing listening)
    const stderr =
      "fatal: unable to access 'https://127.0.0.1:9/repo.git/': " +
      "Failed to connect to 127.0.0.1 port 9: Connection refused\n";
    expect(classifyGitNetworkError(stderr).kind).toBe("host-unreachable");
  });

  it("classifies a real DNS resolution failure (SSH) as host-unreachable", () => {
    // real: `git fetch git@nonexistent-ssh-host-xyz-12345.invalid:repo.git`
    const stderr =
      "ssh: Could not resolve hostname nonexistent-ssh-host-xyz-12345.invalid: Name or service not known\n" +
      "fatal: Could not read from remote repository.\n\n" +
      "Please make sure you have the correct access rights\n" +
      "and the repository exists.\n";
    expect(classifyGitNetworkError(stderr).kind).toBe("host-unreachable");
  });

  it("classifies a real connection-timeout failure (SSH) as host-unreachable", () => {
    // real: `git fetch git@203.0.113.1:repo.git` with a 5s ConnectTimeout, against a
    // non-routable TEST-NET-3 address (RFC 5737).
    const stderr =
      "ssh: connect to host 203.0.113.1 port 22: Connection timed out\n" +
      "fatal: Could not read from remote repository.\n\n" +
      "Please make sure you have the correct access rights\n" +
      "and the repository exists.\n";
    expect(classifyGitNetworkError(stderr).kind).toBe("host-unreachable");
  });

  it("falls back to unknown for an unrecognized failure, never throwing and never swallowing the raw text", () => {
    const stderr = "fatal: something totally unrecognized happened here\n";
    const result = classifyGitNetworkError(stderr);
    expect(result.kind).toBe("unknown");
    expect(result.rawStderr).toContain("something totally unrecognized happened here");
  });

  it("falls back to unknown for a real 'repository not found' message (does not force-fit https-auth-failed)", () => {
    // real: provoked via a fetch against a nonexistent/inaccessible github.com path.
    const stderr = "fatal: repository 'https://github.com/o/definitely-does-not-exist.git/' not found\n";
    expect(classifyGitNetworkError(stderr).kind).toBe("unknown");
  });

  it("falls back to unknown for an empty stderr string", () => {
    expect(classifyGitNetworkError("").kind).toBe("unknown");
  });

  it("never surfaces an unredacted credential in rawStderr, for any classified outcome", () => {
    const stderr =
      "fatal: Authentication failed for 'https://user:supersecrettoken@github.com/o/r.git/'\n";
    const result = classifyGitNetworkError(stderr);
    expect(result.kind).toBe("https-auth-failed");
    expect(result.rawStderr).not.toContain("supersecrettoken");
    expect(result.rawStderr).toContain("https://***@github.com/o/r.git/");
  });

  it("never surfaces an unredacted credential in rawStderr for the unknown outcome either", () => {
    const stderr = "fatal: some new host emitted https://user:supersecrettoken@host.example/x error we don't recognize\n";
    const result = classifyGitNetworkError(stderr);
    expect(result.kind).toBe("unknown");
    expect(result.rawStderr).not.toContain("supersecrettoken");
  });

  it("every classified outcome's message never claims GitHydra can fix, store, or manage credentials", () => {
    const fixtures = [
      "Permission denied (publickey).",
      "Host key verification failed.",
      "fatal: Authentication failed for 'https://host/x.git/'",
      "Could not resolve host: host.example",
      "totally unrecognized",
    ];
    for (const stderr of fixtures) {
      const { message } = classifyGitNetworkError(stderr);
      expect(message.toLowerCase()).not.toMatch(/gitHydra (can|will|automatically) (fix|store|save|manage|remember)/i);
    }
  });
});
