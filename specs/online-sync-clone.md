# PRD: Online Sync — Clone

Status: draft — **Phase 5 of 5** of V2's online-sync milestone, last by design. Clone has the most
net-new UI surface (destination-folder picker, long-running progress, mid-operation cancellation
cleanup) and is the most failure-prone of the four operations, so it reuses Phase 1's already-proven
progress/cancel/credential-failure infrastructure rather than being where that infrastructure is
built for the first time.

Activates the reserved-but-inert "Clone a repository" slot from `specs/repo-list.md` (Must-have 2 /
AC11) — currently a permanently disabled button in `EmptyState.tsx` with a "not yet available"
tooltip, kept deliberately inert until this phase.

Sequencing: git-core-engineer builds first (clone plumbing, destination-safety checks,
cancel-cleanup); ui-graphics builds second (landing-screen Clone form, progress UI, new-tab
handoff). **security-reviewer review required before merge — destination-path handling and
cancel-cleanup deserve the same scrutiny `pathSafety.ts`'s existing symlink-escape guard got**; see
`specs/online-sync-security-flags.md`.

## Problem

There is no way to bring a brand-new repository into GitHydra at all — every repo has to already
exist on disk, via an external `git clone` or a pre-existing checkout. `repo-list.md` explicitly
reserved layout space for this and explicitly deferred building it.

## Target user

A developer who has a clone URL (from any host, or a bare local path) and wants it opened directly
into a working GitHydra tab without shelling out first.

## Must-have behavior

- **FR-351:** The landing screen's reserved "Clone a repository" slot becomes live: a URL field
  (any transport git supports — https, ssh, a local path — never restricted to a specific host's
  URL shape) and a destination-folder picker (native OS dialog, sensible default parent). The
  existing disabled-button tests in `EmptyState.test.tsx` / `App.repoList.test.tsx` are updated as
  part of this phase, since the button is no longer inert.
- **FR-352:** `git clone <url> <destination>` — plain, no flags beyond the two positional args (see
  Non-goals). The URL is treated as user/repo-controlled input and passed with the same
  `withEndOfOptions()`-style protection `gitProcess.ts` already requires for any non-literal
  revision-like argument, since a crafted URL beginning with `-` could otherwise be misparsed as a
  flag.
- **FR-353:** Clone refuses — surfacing git's real reason — rather than proceeding when the
  destination already contains files. It never silently merges into or overwrites existing content.
- **FR-354:** Progress and cancel reuse Phase 1's exact pattern (`--progress` stderr parsing,
  `AbortSignal`-based cancel).
- **FR-355:** Cancelling mid-clone deletes the destination directory **if and only if GitHydra
  itself created it moments earlier as empty for this clone** — verified by GitHydra tracking that
  it was the creator, never inferred from the directory merely being empty, and never deleting a
  pre-existing directory the user pointed at.
- **FR-356:** On success, the cloned repo opens automatically as a new tab (`multi-repo-tabs.md`'s
  existing flow) and is added to `repo-list.md`'s recent-repositories list, same as any other
  successfully opened repo.
- **FR-357:** Credential failure during clone reuses Phase 1's exact classification and redaction
  (FR-323/FR-324) verbatim.
- **FR-358:** No host-specific "browse your repos" UI of any kind — the user must already have the
  clone URL, exactly like the CLI. Anything more requires a host API call and is explicitly deferred
  to V3 per the standing decision on host-API features.

## Non-goals

- **Shallow clones (`--depth`), `--recurse-submodules`, mirror/bare clones (`--mirror`/`--bare`).**
  Simplest correct form only, this pass.
- **Browsing a host's repo list via its API.** V3.
- **Bundling a Phase 2 identity-profile application into the clone flow.** Applying a profile
  remains a separate, explicit step after clone completes.
- **Cloning into an already-open tab's location, or replacing an existing tab** — clone always
  creates a genuinely new tab (`multi-repo-tabs.md`'s existing dedup rules still apply if the
  resulting path happens to already be open).

## Acceptance criteria

1. Cloning a reachable local bare fixture repo by path produces a real working-tree checkout at the
   chosen destination, opens as a new tab, and appears in Recent Repositories.
2. Cloning into a destination that already contains files is refused with git's real reason
   surfaced verbatim; no partial directory content is created beyond what already existed.
3. Cancelling mid-clone removes the destination directory GitHydra itself created — verified
   nothing is left behind on disk.
4. Cancelling a clone into a destination that had unrelated pre-existing content never deletes that
   content, even though the clone itself is aborted.
5. A credential failure while cloning a private-repo-shaped URL shows the identical classified-error
   UI Phase 1 and Push already established, with any embedded credential redacted.
6. A black-box argv-inspection test confirms `--depth`, `--recurse-submodules`, `--mirror`, and
   `--bare` never appear in any clone-related spawn call.
7. A crafted URL beginning with `-` is safely passed through without being misinterpreted as a git
   flag — verified the same way `branch-management.md` FR-44 verifies for branch names/start-points.
