# PRD: Repo List

## Problem
Opening a repository always requires re-browsing the filesystem via the native OS folder picker, even for repos the user opens every day. There's also no recognition-based way to reopen a known repo, which makes it easy to accidentally browse to the same path twice and end up with duplicate tabs.

## Target user
Developers who work across a fixed, recurring set of repos across sessions (a service + its frontend, a fork + upstream, a handful of client repos) — same as `PRODUCT.md`'s Users section and `specs/multi-repo-tabs.md`'s target user, now extended to *across app relaunches*, not just within one session's tabs.

## Must-have behavior
1. Every successfully opened repo path is added (or moved to front, if already present) to a persisted, most-recently-opened-first list, capped at 20 entries (oldest evicted beyond that). Stored locally only (same mechanism as this app's other persisted preferences, e.g. `localStorage`/userData-backed) — never synced, no telemetry.
2. The "No repository open" empty state, and the "+ New tab" / "Open repository…" entry points, surface this list as clickable "Recent repositories" entries (path + derived label, consistent with existing tab-label derivation) alongside the existing native-dialog "Browse…" affordance — clicking an entry opens that path directly, no OS picker involved.
3. Clicking a recent entry from "+ New tab" or the empty state opens it into a new tab; clicking one from "Open repository…" replaces the active tab's repo — matching each control's existing non-recent-list behavior exactly.
4. If the clicked recent path is already open in an existing tab in the current session, that tab is activated/focused instead of a new tab being created at the same path. This is the mechanism that fixes accidental duplicate-tab opens — scoped only to recent-list-triggered opens (see Non-goals).
5. A recent entry that fails to open (path deleted/moved/no longer a valid git repo) shows an inline "not found" state with a "remove from list" action on that entry — never a silent no-op or crash, and never auto-removed without the user acting.
6. Pure app-level/renderer state — no `packages/git-core` change, no Electron IPC contract change, no network call.

## Non-goals
- Restoring a full tab set (selection, filter, open panel) at relaunch — that's `multi-repo-tabs.md`'s separately-deferred, larger item; this spec only makes reopening a known path fast, not resuming a session.
- Syncing the list across machines — local only, no backend.
- Favorites/pinning/grouping — flat MRU list only; a later polish item if requested.
- Auto-reopening any tab at launch — app still starts at today's empty state, now with a recent list visible on it.
- Deduplicating manually-browsed native-dialog opens — `multi-repo-tabs.md`'s existing "duplicate paths allowed" rule for explicit browse-to-the-same-folder-twice stays exactly as-is; dedup here applies only to recent-list clicks.
- Background-validating recent entries — a path's validity is checked only when clicked, not polled.

## Acceptance criteria
1. Open repo A, quit, relaunch: the empty state shows repo A under "Recent repositories" with no filesystem browsing required.
2. Clicking a recent entry opens that path with no native OS dialog appearing, respecting Must-have 3's per-control behavior.
3. After opening 25 distinct paths in a session, the persisted list holds at most 20, most-recent-first, oldest evicted.
4. With repo A already open in tab 2, clicking repo A in the recent list (from anywhere) focuses tab 2 rather than creating a duplicate.
5. Two tabs opened by manually browsing the native dialog to the same path B remain both open and unaffected — confirms dedup is scoped to recent-list clicks only, not general.
6. Clicking a recent entry whose path no longer exists shows an inline "not found" + "remove from list" state; removing it deletes only that entry, leaving other entries and open tabs untouched.
7. Zero outbound network requests across relaunch, viewing the list, and opening an entry, verified against GitHub/GitLab/Bitbucket/self-hosted/no-remote repos.
8. The recent list is stored locally only — no analytics/telemetry call fires on add/remove/reorder.
9. A fresh profile with no persisted list shows today's empty state with no "Recent repositories" section rendered — no regression to first-run experience.
