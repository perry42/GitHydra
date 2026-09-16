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
 * Keyed on the `://<userinfo>@` shape itself, NOT on a list of known scheme names. An earlier
 * version matched `(https?|ftps?|git|ssh)://` and had two security-reviewed bypasses that this
 * approach structurally cannot have (both verified as real, reproducible leaks before the change):
 *   1. A doubled/nested scheme — `https://https://user:token@host/x` — left the credential fully
 *      exposed. The outer match's authority group consumed the INNER `https` text (a `:` is legal
 *      in an authority), advancing past the only scheme keyword the pattern could have re-matched
 *      on, so the credentialed inner URL was never examined at all.
 *   2. Worse, `https://a:b@https://user:token@host/x` returned `https://***@https://user:token@…`
 *      — visibly "redacted" while leaking the real credential immediately after the mask, which is
 *      exactly the kind of output a reader would glance at and trust.
 * Anchoring on `://` + `@` instead means every credentialed URL in a string is found independently,
 * no matter what precedes it, and an unanticipated scheme fails CLOSED (redacted) rather than open.
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
 * Matches `://<userinfo>@` — the userinfo span of any URL authority that actually carries one.
 *
 * The `[^\s/?#]*` group is greedy and followed by a literal `@`, which is what produces the
 * RFC 3986-correct "last `@` wins" split for free: the engine consumes as far as it can within the
 * authority (stopping at the first `/`, `?`, `#`, or whitespace, so it can never swallow a path,
 * query, or a following word) and then backtracks to the RIGHTMOST `@`. That matters because a
 * host name never contains an unencoded `@`, but a password legitimately can — splitting on the
 * first `@` instead would leave the tail of such a password exposed while masking part of it.
 *
 * A URL with no userinfo (`https://github.com/o/r.git`) simply has no `@` to match and is returned
 * byte-for-byte unchanged, as is the SCP-like SSH shorthand (`git@github.com:user/repo.git`),
 * which has no `://` at all.
 */
const URL_USERINFO_RE = /:\/\/([^\s/?#]*)@/g;

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
  return text.replace(URL_USERINFO_RE, "://***@");
}
