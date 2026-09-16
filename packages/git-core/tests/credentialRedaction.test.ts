// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { redactGitCredentials } from "../src/credentialRedaction";

/**
 * specs/online-sync-fetch.md FR-324 / specs/online-sync-security-flags.md section 1.
 *
 * Verified against real git (2.31.1.windows.1, 2026-09-16): `git remote -v` echoes a configured
 * remote's embedded credentials back completely unredacted (`git remote add x
 * https://user:supersecrettoken@example.com/repo.git` then `git remote -v` prints that exact
 * string), and while several of git's own fatal HTTP(S) error messages on this version already
 * strip userinfo from the URL they print (`fatal: unable to access '<url>'`, `fatal: repository
 * '<url>' not found`), that's git's own behavior for those specific message shapes — not something
 * this codebase can rely on holding for every git version or every surface (config dumps, a future
 * "Remotes" panel, `git config --get remote.<name>.url`, ...). Hence a defensive, standalone helper
 * applied everywhere, rather than trusting git to have already done this.
 */

describe("redactGitCredentials (FR-324)", () => {
  it("redacts a username:password pair embedded in an https URL", () => {
    const input = "fatal: Authentication failed for 'https://user:TOKEN123@github.com/o/r.git/'";
    expect(redactGitCredentials(input)).toBe(
      "fatal: Authentication failed for 'https://***@github.com/o/r.git/'",
    );
  });

  it("redacts a token-as-username with no password", () => {
    // A real, common pattern: a GitHub PAT used directly as the URL username, no password.
    const input = "remote: fetching https://ghp_abc123DEF456@github.com/o/r.git failed";
    expect(redactGitCredentials(input)).toBe(
      "remote: fetching https://***@github.com/o/r.git failed",
    );
  });

  it("redacts a password containing unusual/percent-encoded characters", () => {
    const input = "https://user:p%40ss!%24%25%5E@host.example/o/r.git";
    expect(redactGitCredentials(input)).toBe("https://***@host.example/o/r.git");
  });

  it("passes a credential-free https URL through completely unchanged", () => {
    const input = "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com";
    expect(redactGitCredentials(input)).toBe(input);
  });

  it("passes a string containing no URL at all through completely unchanged", () => {
    const input = "fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.";
    expect(redactGitCredentials(input)).toBe(input);
  });

  it("does NOT mangle an SCP-like SSH remote (git@host:user/repo.git) — no scheme, never a secret", () => {
    const input = "fatal: could not fetch from git@github.com:torvalds/linux.git";
    expect(redactGitCredentials(input)).toBe(input);
  });

  it("does NOT mangle a bare SSH host with a plain username and no scheme (ssh config alias form)", () => {
    const input = "Cloning into 'linux'...\nremote: git@my-ssh-alias:org/repo.git";
    expect(redactGitCredentials(input)).toBe(input);
  });

  it("redacts an explicit ssh:// URL's userinfo defensively, even though ssh auth isn't really URL-embedded", () => {
    const input = "fatal: unable to connect to ssh://deploy:hunter2@git.example.com:2222/o/r.git";
    expect(redactGitCredentials(input)).toBe("fatal: unable to connect to ssh://***@git.example.com:2222/o/r.git");
  });

  it("redacts every URL independently when more than one appears in the same string", () => {
    const input =
      "tried https://a:b@host1.example/x.git and https://c:d@host2.example/y.git, both failed";
    expect(redactGitCredentials(input)).toBe(
      "tried https://***@host1.example/x.git and https://***@host2.example/y.git, both failed",
    );
  });

  it("leaves a URL's query string and fragment untouched when there are no credentials", () => {
    const input = "https://example.com/o/r.git?ref=main#section";
    expect(redactGitCredentials(input)).toBe(input);
  });

  it("stops the authority match at the first '/', '?', or '#' — does not swallow path/query content into the host", () => {
    const input = "https://user:pass@example.com/o/r.git?token=abc@def";
    // The `@` inside the query string is NOT part of the authority component (it comes after the
    // first `/`), so it must be left alone — only the real credential before the host is redacted.
    expect(redactGitCredentials(input)).toBe("https://***@example.com/o/r.git?token=abc@def");
  });

  it("handles an empty string", () => {
    expect(redactGitCredentials("")).toBe("");
  });

  it("redacts a bare credentialed URL with nothing else around it", () => {
    expect(redactGitCredentials("https://user:pass@example.com/repo.git")).toBe(
      "https://***@example.com/repo.git",
    );
  });

  it("is case-insensitive on the scheme", () => {
    expect(redactGitCredentials("HTTPS://user:pass@Example.com/repo.git")).toBe(
      "HTTPS://***@Example.com/repo.git",
    );
  });

  it("redacts a git:// URL defensively even though the git protocol has no real auth concept", () => {
    expect(redactGitCredentials("git://user:pass@example.com/repo.git")).toBe(
      "git://***@example.com/repo.git",
    );
  });

  /**
   * Security-review regressions. The original scheme-allowlist implementation
   * (`\b(https?|ftps?|git|ssh)://` + an authority group) leaked on all three of these; every one
   * was reproduced as a real leak before being fixed. They are the reason this function anchors on
   * the `://<userinfo>@` shape rather than on known scheme names — see the module doc comment.
   */
  describe("security-review regressions — credentials must never survive redaction", () => {
    it("redacts a credentialed URL nested behind a doubled scheme", () => {
      // The outer match used to consume the inner `https` text, advancing past the only scheme
      // keyword that could have re-matched, so this leaked entirely untouched.
      expect(redactGitCredentials("https://https://user:token@github.com/repo.git")).toBe(
        "https://https://***@github.com/repo.git",
      );
    });

    it("redacts BOTH credentials when a second credentialed URL follows a first", () => {
      // The worst of the three: output previously read `https://***@https://user:token@host/x` —
      // visibly masked, while leaking the real credential immediately after the mask.
      const out = redactGitCredentials("https://a:b@https://user:token@host/x");
      expect(out).toBe("https://***@https://***@host/x");
      expect(out).not.toContain("token");
    });

    it("redacts a URL glued directly onto a preceding word character", () => {
      // The old leading `\b` required a non-word character before the scheme, so a scheme fused to
      // a preceding word (a typo, or a future caller interpolating without a separator) bypassed
      // redaction with no signal anything had been skipped.
      expect(redactGitCredentials("seehttps://user:token@host.example/repo.git")).toBe(
        "seehttps://***@host.example/repo.git",
      );
    });

    it("redacts an unanticipated scheme rather than failing open", () => {
      // Anchoring on `://` + `@` instead of an allowlist means a scheme nobody predicted is still
      // redacted — the safe direction to be wrong in.
      expect(redactGitCredentials("weird://user:tok@host/x")).toBe("weird://***@host/x");
    });

    it("still splits on the LAST @ when a password contains an unencoded one", () => {
      expect(redactGitCredentials("https://user:p@ss@host/x")).toBe("https://***@host/x");
    });
  });
});
