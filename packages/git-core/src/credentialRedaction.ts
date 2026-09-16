// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * specs/online-sync-fetch.md FR-324 / specs/online-sync-security-flags.md section 1: a reusable,
 * exported redaction helper for any credential embedded in a remote URL
 * (`https://user:TOKEN@host/repo.git`) — a discouraged but real pattern. Every future network
 * surface (fetch, push, clone) must run ANY string that could contain a remote URL through this
 * before it reaches an error banner, a progress line, a collapsible raw-stderr detail view, or a
 * logging call, per the security-review flag calling this "the single most important item" in the
 * V2 online-sync checklist. Deliberately NOT inlined into one call site (e.g. the network-error
 * classifier below) so every future call site shares exactly one implementation instead of each
 * growing its own slightly-different regex.
 *
 * Verified directly against real git (2.31.1, 2026-09-16) that this concern is not hypothetical:
 * `git remote -v` and `git remote add <name> <url-with-credentials>` both echo a configured
 * remote's credentials back completely unredacted — git itself does NOT scrub this anywhere in
 * its own plumbing. Some (not all) of git's own fatal error messages for HTTP(S) failures already
 * strip userinfo from the URL they print (e.g. "unable to access '<url>'", "repository '<url>' not
 * found" — verified empirically), but that is git's behavior for those specific message shapes on
 * this version, not a guarantee this codebase can rely on across every git version or every surface
 * (`git remote -v` output, a future "Remotes" panel, config dumps, ...). Redacting defensively,
 * everywhere a URL might appear, is the only safe posture.
 *
 * Scope decision: only text that looks like `<scheme>://<userinfo>@<host>...` is touched.
 * `git@github.com:user/repo.git` (the SCP-like SSH shorthand — no `scheme://`) is deliberately left
 * completely alone, per FR-324's own explicit callout: that syntax's `git@` segment is an SSH
 * *username* (almost always literally the string "git"), never a secret — SSH auth happens via a
 * key/agent, not anything embedded in this string. An `ssh://user@host/...` URL (WITH an explicit
 * scheme) IS still redacted, conservatively: unlike the SCP-like shorthand, `ssh://` URL syntax can
 * legally carry a password (`ssh://user:pass@host/...`, rare but valid), and a bare username in
 * that position (no password) can itself be a secret in practice — most concretely, GitHub personal
 * access tokens are commonly placed as the URL *username* with no password at all
 * (`https://ghp_xxx@github.com/...`). Because a username-only credential can be just as sensitive as
 * a username:password pair, and because there is no reliable way to tell "safe username" (e.g. the
 * literal string "git") apart from "token used as a username" from the URL text alone, this always
 * redacts the ENTIRE userinfo segment (username, and password if present) uniformly to `***` rather
 * than trying to guess which part is safe to keep visible.
 */

/**
 * Matches a URL's scheme + authority component (everything from `scheme://` up to the first `/`,
 * `?`, or `#`, or the end of the match) for every scheme a git remote URL can legitimately use.
 * `git://` is included even though the git protocol itself has no concept of embedded auth — a
 * user could still type `git://user:pass@host/...` (git's URL parser doesn't reject it), so this
 * redacts it defensively anyway; doing so is always safe (never mangles a credential-free URL) even
 * though it may not be a real transport git would ever successfully use it for.
 */
const URL_AUTHORITY_RE = /\b((?:https?|ftps?|git|ssh):\/\/)([^\s/?#]*)/gi;

/**
 * Redact any embedded credential from every remote-URL-shaped substring in `text`, replacing the
 * whole userinfo segment with `***`. Safe to call on arbitrary text (a full stderr blob, a single
 * progress line, a bare URL) — a string containing no URL, or a URL with no embedded credentials,
 * is returned byte-for-byte unchanged (verified in `credentialRedaction.test.ts`).
 *
 * Splits on the LAST `@` within the matched authority segment (per RFC 3986: only the final `@`
 * before the host delimits userinfo from host — a password containing an unencoded, non-compliant
 * literal `@` would otherwise be truncated at the wrong point). A password with unusual characters
 * (spaces are invalid unescaped in a URL; anything else — `!$%^&*()`, percent-escapes like `%40`
 * for a literal `@`, etc.) is preserved as opaque bytes within the userinfo span and fully redacted
 * along with it; nothing about its content leaks into the replacement.
 */
export function redactGitCredentials(text: string): string {
  if (!text) return text;
  return text.replace(URL_AUTHORITY_RE, (fullMatch, schemePart: string, authority: string) => {
    const atIndex = authority.lastIndexOf("@");
    if (atIndex === -1) {
      // No `@` in the authority segment at all: either a bare host (no credentials — the
      // common, unremarkable case) or an SSH-shorthand-style string that didn't actually match
      // this scheme-anchored pattern in the first place. Either way, nothing to redact.
      return fullMatch;
    }
    const host = authority.slice(atIndex + 1);
    return `${schemePart}***@${host}`;
  });
}
