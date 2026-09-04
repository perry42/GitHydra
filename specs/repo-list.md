# PRD: Repo List

## Problem
Opening a repository always requires re-browsing the filesystem via the native OS folder picker, even for repos the user opens every day. There's also no recognition-based way to reopen a known repo, which makes it easy to accidentally browse to the same path twice and end up with duplicate tabs.

## Target user
Developers who work across a fixed, recurring set of repos across sessions (a service + its frontend, a fork + upstream, a handful of client repos) — same as `PRODUCT.md`'s Users section and `specs/multi-repo-tabs.md`'s target user, now extended to *across app relaunches*, not just within one session's tabs.

## Must-have behavior
1. Every successfully opened repo path is added (or moved to front, if already present) to a persisted, most-recently-opened-first list, capped at 20 entries (oldest evicted beyond that). Stored locally only (same mechanism as this app's other persisted preferences, e.g. `localStorage`/userData-backed) — never synced, no telemetry.
2. **(Revised.)** Every "No repository open" screen — whether it's the very first tab, or a tab freshly created via "+ New tab" — is the single landing surface for opening a repo, shown directly on that screen (never behind a caret, popover, or modal). It shows an "Open a repository" action (launches the native OS folder dialog) alongside a visually reserved but inactive "Clone a repository" slot (see Non-goals — not built, just not painted into a layout corner for later), and, whenever the recent list is non-empty, a "Recent repositories" panel beneath them listing entries (path + derived label, consistent with existing tab-label derivation). There is no separate "Open repository…" toolbar action anywhere in the app — "+ New tab" is the one way to reach this screen.
3. **(Revised.)** Clicking a recent entry, or "Open a repository," from this landing screen always opens into the tab that's currently showing it — the fresh "+ New tab" tab, or the initial tab before any repo has been opened. There is no separate "replace the currently-open active tab's repo" action; to open a different repo while one is already showing, the user opens a new tab via "+" first.
4. **(Revised — now global, not recent-list-only.)** Any successful repo-open — a recent-list click, or manually browsing via the native OS dialog — that resolves to a path already open in an existing tab in the current session activates/focuses that tab instead of creating a duplicate. This supersedes `multi-repo-tabs.md` Must-have 9 ("duplicate repo paths allowed") and that spec's AC10, both retired by this revision.
5. **(Revised — added a retry affordance.)** A recent entry that fails to open (path deleted/moved/no longer a valid git repo) shows an inline "not found" state with two actions on that entry: "Try again" (re-attempts the same open — covers the transient case, e.g. a removable drive reconnected or a network share that's back) and "Remove" (removes it from the list). Never a silent no-op or crash, and never auto-removed without the user acting. A second consecutive failure after "Try again" simply leaves the not-found state showing (no error dialog, no retry-count limit) — the user decides whether to try again or remove it.
6. Pure app-level/renderer state — no `packages/git-core` change, no Electron IPC contract change, no network call.

## Non-goals
- Restoring a full tab set (selection, filter, open panel) at relaunch — that's `multi-repo-tabs.md`'s separately-deferred, larger item; this spec only makes reopening a known path fast, not resuming a session.
- Syncing the list across machines — local only, no backend.
- Favorites/pinning/grouping — flat MRU list only; a later polish item if requested.
- Auto-reopening any tab at launch — app still starts at today's empty state, now with a recent list visible on it.
- **(Retired.)** ~~Deduplicating manually-browsed native-dialog opens~~ — reversed by the global-dedup revision (Must-have 4): at most one tab for a given path can exist at a time, regardless of which entry point opened it.
- Background-validating recent entries — a path's validity is checked only when clicked (or when "Try again" is clicked), not polled.
- Building a working "Clone a repository" action. The landing screen visually reserves a slot for one (Must-have 2), but no clone/host-auth flow is in scope here — there's no spec for it yet, and GitHydra's product principles bar forced host-specific sign-in regardless. This is a layout accommodation only, not a commitment to build it next.
- A separate "Open repository…" toolbar action that replaces the active tab's repo in place. Retired by the Must-have 2/3 revision — "+ New tab" is now the only way to open a repo, whether or not one is already showing.

## Acceptance criteria
1. Open repo A, quit, relaunch: the empty state shows repo A under "Recent repositories" with no filesystem browsing required.
2. **(Revised.)** Clicking a recent entry from the landing screen opens that path directly with no native OS dialog appearing.
3. After opening 25 distinct paths in a session, the persisted list holds at most 20, most-recent-first, oldest evicted.
4. With repo A already open in tab 2, clicking repo A in the recent list (from anywhere) focuses tab 2 rather than creating a duplicate.
5. **(Revised — was the "dedup is scoped to recent-list only" proof, now the opposite.)** Manually browsing via the native OS dialog to a path B that's already open in another tab focuses that existing tab instead of creating a new one — same outcome as AC4, triggered from the manual-browse entry point instead of a recent-list click. At most one tab for path B exists at any time, regardless of which entry point was used to open it.
6. **(Revised — added Try again.)** Clicking a recent entry whose path no longer exists shows an inline "not found" state with "Try again" and "Remove"; clicking Remove deletes only that entry, leaving other entries and open tabs untouched; clicking "Try again" re-attempts the open (and, if the path is valid again, opens it normally — otherwise the not-found state simply remains).
7. Zero outbound network requests across relaunch, viewing the list, and opening an entry, verified against GitHub/GitLab/Bitbucket/self-hosted/no-remote repos.
8. The recent list is stored locally only — no analytics/telemetry call fires on add/remove/reorder.
9. A fresh profile with no persisted list shows the landing screen's "Open a repository" / reserved "Clone a repository" actions with no "Recent repositories" section rendered — no regression to first-run experience.
10. No separate "Open repository…" toolbar action, popover, or modal dialog exists anywhere in the app for opening a repo — the landing screen (Must-have 2) is the only surface, reached via "+ New tab" or shown as the initial "No repository open" state.
11. The landing screen shows a visually reserved "Clone a repository" action alongside "Open a repository" that is present in layout but inert (disabled or otherwise a deliberate no-op, never a broken/dead click target) — so the layout needs no rework when Clone is eventually built.
