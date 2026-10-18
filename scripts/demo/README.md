# Manual-testing kit (scripts/demo)

Practice repos for trying GitHydra by hand in the REAL app. Dev-only: it is never packaged. The long guide, with every scenario and what to check, is `docs/manual-testing/README.md`.

## Start it (pick one, no typing needed)

1. **Double-click `play.cmd`** (this folder). A menu lists the scenarios; type a number, press Enter.
2. **VS Code:** Terminal > Run Task > "GitHydra demo kit: menu".
3. **VS Code Explorer:** open `package.json` here, click the play button next to a script in the NPM Scripts panel (one script per scenario).
4. **Terminal:** `node scripts/demo/menu.mjs` (menu) or `npm run demo -- <scenario>` from the repo root.

The app is rebuilt automatically if it is out of date (this takes a minute). Close the app window with **X** when you are done: the practice repo and the throwaway profile are deleted. Your real GitHydra settings and tabs are never touched, and repos are created only in your temp folder.

## What each file does

| File | Purpose |
|---|---|
| `menu.mjs` / `play.cmd` | The pick-a-scenario menu and its double-click launcher |
| `run.mjs` | Builds a scenario's repo and opens the built app on it (the real command) |
| `build.mjs`, `launch.mjs`, `lib.mjs` | Repo building, app launching, shared helpers |
| `tick.mjs` | Makes live git changes from outside while the app is open |
| `scenarios/*.mjs` | The practice repos (`conflicts`, `changes`, `repos`); `index.mjs` joins them |

## Handy options (add to `npm run demo -- <scenario> ...`)

`--keep` keep the repo after closing, `--same-profile` keep one profile across runs (crash-recovery scenario), `--smoke` launch, check, close, `--auto-build` rebuild if stale. `GITHYDRA_DEMO_SCALE=0.05` shrinks the big scenarios.

## Change things while the app is open

`npm run demo -- tick <repo-path> [action]` runs real git commands on a practice repo (`branch`, `commit`, `checkout`, `dirty`, `stash`, `tag`, `merge-start`, `merge-abort`, `auto`). The repo path is printed when a scenario launches (use `--keep` so you can reuse it).

## Add a scenario

Append an object to a file in `scenarios/` (copy `worktrees-tour` in `repos.mjs`), add a play script in this folder's `package.json`, a row in the long guide and the name in `packages/git-core/tests/demoKit.test.ts`.

## Report a problem in one line

`[scenario] [what you did] -> [what you saw] vs [what you expected] | build <git short sha> | theme | window size | repo path`
