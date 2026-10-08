# Tech stack decisions — rationale

Referenced from `CLAUDE.md`'s Tech stack section. Read this when you need the *why* behind
a stack choice (e.g. reconsidering it, or explaining it to a contributor) — CLAUDE.md itself
only keeps the *what*, since the reasoning doesn't need to be in every session's context.

## Desktop shell: Electron
`packages/git-core` already runs on Node.js `child_process.spawn`; Electron's main process is
Node.js, so `git-core` plugs in directly with no bridging layer. Tauri's backend is Rust — using
`git-core` from Tauri would mean either bundling a Node sidecar just to run it, or reimplementing
the git-shelling logic in Rust, which throws away a decision already made.

## Frontend framework: React
Matches the TypeScript-first stack already committed to; has the deepest ecosystem of
virtualization/canvas libraries for rendering a 100k–1M-commit graph (FR-3/FR-12 in
`specs/commit-graph.md`); and since GitHydra is meant to attract outside open-source
contributors, React has the largest available contributor pool of any framework choice.

## Language: TypeScript on Node.js (>=18)
Decided for the git-core logic (`packages/git-core`); also decided for the rest of the app
(Electron main/preload/renderer, React UI) for the same reason — one language across the stack.

## Package manager: npm, npm workspaces (`packages/*`)
Root `package.json` already set up this way.

## Git integration approach: shell out to system `git` CLI
Via `child_process.spawn`, argv arrays only (never a shell string). libgit2 bindings (e.g.
nodegit) are poorly maintained and lag git's own edge-case handling (grafts, shallow,
worktrees); isomorphic-git doesn't cover the full plumbing surface (worktrees, shallow/graft
nuances) and reimplements git's object/pack formats itself, which is more surface area to get
subtly wrong. Shelling out to the user's real, already-installed git inherits git's own
correctness for every edge case for free, at the cost of requiring git on PATH (git >= 2.24,
for `--end-of-options`; see `packages/git-core/README.md`).

## Edit-in-diff editor: CodeMirror 6 (plain text only)
`specs/edit-in-diff.md` FR-469 asks for line numbers, undo history, Tab indent and byte-faithful line
endings/BOM in a small in-app editor. CodeMirror 6 (MIT) keeps its text outside React, handles
large single-file buffers and IME/accessibility natively, and gives the later gutter-marker/peek slice
a real extension point; a `<textarea>` would have covered this slice but has no gutter, no
coordinate API and a browser-owned undo stack that a programmatic reload would wipe. Only the three
core packages are used (`@codemirror/state`, `@codemirror/view`, `@codemirror/commands` for `history`
and the standard keymap); no language, autocomplete, search, lint or highlight packages, no theme
package (theming is one `EditorView.theme` over the existing `--gh-*` tokens).

License check (`oss-licensing-guardrails`; GPL-3.0-or-later compatible, all MIT), every package that
landed in `package-lock.json`: `@codemirror/state` 6.7.6, `@codemirror/view` 6.43.14,
`@codemirror/commands` 6.11.1, and transitively `@codemirror/language` 6.13.1,
`@codemirror/streamparser` 6.0.0, `@lezer/common` 1.5.3, `@lezer/highlight` 1.2.5, `@lezer/lr` 1.4.11,
`@marijn/find-cluster-break` 1.0.4, `crelt` 1.0.7, `style-mod` 4.1.4, `w3c-keyname` 2.2.8. The
`language`/`lezer` packages come with `@codemirror/commands` (it imports them) and are tree-shaken
where they can be; the renderer bundle grew about 305 KB raw (767,013 to 1,072,498 bytes of JS, about
99 KB gzipped: 213,588 to 312,295 bytes). Loading is eager: the editor shares the one renderer chunk (splitting it
behind a dynamic import is a possible later saving, not needed for correctness).

Behaviour decisions made while building: Tab inserts/removes the file's own indent unit (detected, not
configured); a mixed-EOL file is edited with `\n` as the only line break so every `\r` stays in the text
and is saved verbatim; reloads from disk go through a transaction that is excluded from undo history.
