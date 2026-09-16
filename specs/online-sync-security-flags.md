# Online Sync — consolidated security-review flags

Status: companion doc to V2's five online-sync specs. Not a PRD — a standing checklist for
security-reviewer, since this milestone is the first work in the project's history to touch
credentials and the network.

Every phase below requires a security-reviewer pass before merge, per `AGENTS.md`'s existing
workflow. These are the specific things to look for, in priority order.

## 1. Phase 1 — credential redaction in remote URLs (highest priority)

`specs/online-sync-fetch.md` FR-324. Confirm no code path ever surfaces an unredacted embedded
credential (`https://user:TOKEN@host/...`) in the UI, in logs, or in the collapsible raw-stderr
detail view.

This is a real leak that neither the roadmap nor the initial feature framing caught — a user who
has a token embedded in their own remote URL (discouraged, but a real pattern) would otherwise have
it echoed back on screen in any error banner. Treat this as the single most important item in this
list. It applies to every remote URL displayed anywhere in the app from Phase 1 forward, not only
to fetch's own error path.

## 2. Phase 1 — the reframed `noNetworkCalls.test.ts` contract

`specs/online-sync-fetch.md` FR-328. Confirm the new network-capable code paths are exactly
`fetchRemote`/`fetchAllRemotes` (and later, pull/push/clone's own functions) and nothing else —
specifically, that no shared helper introduced for this phase silently grants network capability to
a function that shouldn't have it.

Every pre-V2 describe block in that file must remain unmodified and still assert zero network
subcommands. The new capability is additive and narrowly scoped, never a loosening of the existing
guarantee.

## 3. Phase 2 — `core.sshCommand` construction (highest-value single review)

`specs/git-identity-profiles.md` FR-331/FR-333. This is a config **value** that git itself parses
as a shell command when invoking ssh — a materially different risk class from this codebase's
existing argv-array convention, which protects only how *we* invoke git, not what git does with a
value we hand it.

Confirm: path validation **rejects** shell-metacharacter-bearing paths rather than attempting to
escape them; the identity file is chosen via the native OS dialog, not a trusted free-text field;
and FR-334's pre-existing-value-clobber guard actually works (a user's own `core.sshCommand`, e.g.
for a corporate SSH proxy, must not be silently overwritten).

Also confirm FR-337: no SSH private key's *contents* are ever read, logged, transmitted, or
displayed — only a path is stored.

## 4. Phase 4 — force-flag absence

`specs/online-sync-push.md` FR-344 and its Non-goals. Confirm no code path — including via a future
parameter or typo — can reach `--force`, `-f`, `--force-with-lease`, `--delete`, or `--mirror` on a
push call.

Recommend a permanent, dedicated argv-inspection test (mirroring `noNetworkCalls.test.ts`'s own
black-box technique) as a standing regression guard, not just a one-time review. The exclusion of
destructive remote operations is a product decision for this milestone, and it should be enforced
mechanically rather than by reviewer memory.

## 5. Phase 5 — clone URL and destination handling

`specs/online-sync-clone.md` FR-352/FR-355. The clone URL is exactly the "user/repo-controlled
string passed as a positional git argument" category `withEndOfOptions()` already exists for —
confirm it is actually applied, so a URL beginning with `-` can't be misparsed as a flag.

Separately, review the cancel-cleanup delete logic with the same rigor `pathSafety.ts`'s existing
symlink-escape guard received. Deleting a directory based on a path the user or the app chose is
exactly the kind of check-then-use operation where that class of bug lives. The guarantee to verify
is FR-355's: GitHydra deletes only a directory it positively tracked itself as having created for
this clone — never one inferred to be safe because it merely looked empty.
