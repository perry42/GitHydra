# Conflict-first Changes layout

Short note (no full PRD). Fixes two bugs seen in a real merge demo.

- **FR-573:** While the working tree has conflicted files, the Changes list renders Conflicted first (and keyboard row order matches).
- **FR-574:** Staged, Unstaged and Untracked then show as collapsed header rows with counts (buttons, `aria-expanded`); a click expands. Nothing persists across sessions; once no conflicts remain, normal order and expansion return.
- **FR-575:** When a merge, rebase or cherry-pick is in progress, opening Changes opens the first conflicted file once per mount (block editor if eligible, else the file-level view with the reason). Commit stays disabled as before.
- **FR-576:** The file-level conflict view's comparison tabs and action buttons wrap to their content height; text never overflows the button box or overlaps the heading, at default and narrow width.

Assumption: collapse applies to any conflicted state (including stash apply/pop); auto-open only with an operation in progress.
