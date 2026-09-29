// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from "vitest";
import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import { cleanup, commitAll, git, initRepo, writeFile } from "./test/gitFixture";
import { REF_GUTTER_WIDTH } from "./components/CommitGraph/graphGeometry";

// Real `git` child-process spawns underneath every `waitFor`, same rationale as
// App.stash.e2e.test.tsx/App.cherryPick.e2e.test.tsx/App.blame.e2e.test.tsx.
configure({ asyncUtilTimeout: 12000 });

/**
 * Verification gate for feature/branch-tag-gutter (ui-graphics, security-reviewer clean):
 * exercises the persistent branch/tag/HEAD ref-chip gutter (CommitRow.tsx/RefChip.tsx/
 * graphGeometry.ts) against a REAL running `<App/>` + REAL git-core + a REAL temp repo on disk —
 * no git-core mocking anywhere in this file. `CommitRow.test.tsx`/`RefChip.test.tsx` already cover
 * this at component level with fixture data; this file's job is the UI/git-core boundary the
 * component tests can't reach: does right-clicking a real ref chip actually mutate the real repo
 * correctly, and does the gutter/graph layout hold up against this repo's own real branch names
 * (including a name as long as `feature/merge-rebase-conflict-resolution`, the exact name called
 * out in the acceptance criteria) once real `for-each-ref` data flows all the way through.
 *
 * Each test opens its own independent temp repo (no shared fixture state, no ordering dependency).
 */

const handles: RealGitHydraHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  await new Promise((resolve) => setTimeout(resolve, 350));
  while (handles.length) handles.pop()!.dispose();
  while (dirs.length) {
    const dir = dirs.pop()!;
    try {
      await cleanup(dir);
    } catch {
      // Best-effort: an occasional Windows file-lock shouldn't fail this test's own assertions.
    }
  }
});

async function openAppOn(dir: string): Promise<RealGitHydraHandle> {
  const handle = createRealGitHydraApi();
  handles.push(handle);
  handle.setDialogPath(dir);
  window.gitHydra = handle.api;
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
  await screen.findByRole("button", { name: /stashes/i }, { timeout: 10000 });
  return handle;
}

async function commitFile(dir: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(dir, file, content);
  return commitAll(dir, message);
}

async function headSha(dir: string): Promise<string> {
  const { stdout } = await git(dir, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

async function currentBranchName(dir: string): Promise<string> {
  const { stdout } = await git(dir, ["symbolic-ref", "--short", "HEAD"]);
  return stdout.trim();
}

async function localBranchNames(dir: string): Promise<string[]> {
  const { stdout } = await git(dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return stdout.split("\n").filter(Boolean);
}

async function graphRegion(): Promise<HTMLElement> {
  return screen.findByRole("listbox", { name: /commit graph/i });
}

async function rowFor(subject: string): Promise<HTMLElement> {
  const graph = await graphRegion();
  const text = await within(graph).findByText(subject);
  const row = text.closest('[role="option"]');
  if (!row) throw new Error(`row not found for subject: ${subject}`);
  return row as HTMLElement;
}

const LONG_BRANCH = "feature/merge-rebase-conflict-resolution";

describe("feature/branch-tag-gutter — real App + real git-core integration", () => {
  it(
    "AC1: right-clicking a real local-branch ref chip's Checkout item actually switches HEAD to that branch in the real repo, using the real for-each-ref name (not a truncated display string)",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "base\n", "base commit");
      await git(dir, ["checkout", "-q", "-b", LONG_BRANCH]);
      const featureSha = await commitFile(dir, "b.txt", "feature\n", "feature commit");
      await git(dir, ["checkout", "-q", "main"]);

      expect(await currentBranchName(dir)).toBe("main");

      await openAppOn(dir);
      const featureRow = await rowFor("feature commit");
      const chip = within(featureRow).getByRole("img", { name: new RegExp(`local branch: ${LONG_BRANCH.replace(/\//g, "\\/")}$`) });
      // Full real name is on the accessible label/title despite the column visually truncating it.
      expect(chip).toHaveAttribute("title", expect.stringContaining(LONG_BRANCH));
      expect(chip.className).not.toContain("gh-refchip--filled"); // not checked out yet.

      fireEvent.contextMenu(chip, { clientX: 20, clientY: 20 });
      const menu = await screen.findByRole("menu", { name: new RegExp(`Actions for branch ${LONG_BRANCH.replace(/\//g, "\\/")}`) });
      const checkoutItem = within(menu).getByRole("menuitem", { name: /^checkout$/i });
      await userEvent.click(checkoutItem);

      // Real repo: HEAD is now the feature branch's real tip commit, on the real branch ref.
      await waitFor(async () => expect(await headSha(dir)).toBe(featureSha));
      expect(await currentBranchName(dir)).toBe(LONG_BRANCH);

      // Real UI: the chip now reflects "checked out" (bold ink, no color) — never a stale filled
      // main chip once HEAD has actually moved.
      await waitFor(() => {
        const updatedChip = within(featureRow).getByRole("img", { name: new RegExp(`local branch: ${LONG_BRANCH.replace(/\//g, "\\/")}$`) });
        expect(updatedChip.className).toContain("gh-refchip--filled");
        expect(updatedChip.getAttribute("style")).toBeNull();
      });
    },
    30000,
  );

  it(
    "AC1: right-clicking a non-checked-out local-branch ref chip's Delete item, after confirming, actually removes that branch from the real repo",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "base\n", "base commit");
      await git(dir, ["branch", LONG_BRANCH]); // not checked out — main stays current.
      // specs/ref-chip-gutter-legibility.md FR-408: advance main's own tip to a second commit so
      // "base commit" carries ONLY the LONG_BRANCH decoration — otherwise main's still-current,
      // filled chip would also land on this same row, collapsing LONG_BRANCH's chip behind a
      // "+1" affix (informational-only in v1, see that spec's Non-goals) before this test ever
      // gets to right-click it.
      await commitFile(dir, "b.txt", "next\n", "next commit");

      await openAppOn(dir);
      const row = await rowFor("base commit");
      const chip = within(row).getByRole("img", { name: new RegExp(`local branch: ${LONG_BRANCH.replace(/\//g, "\\/")}$`) });

      fireEvent.contextMenu(chip, { clientX: 20, clientY: 20 });
      const menu = await screen.findByRole("menu", { name: new RegExp(`Actions for branch ${LONG_BRANCH.replace(/\//g, "\\/")}`) });
      const deleteItem = within(menu).getByRole("menuitem", { name: /^delete/i });
      await userEvent.click(deleteItem);

      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toHaveTextContent(new RegExp(LONG_BRANCH.replace(/\//g, "\\/")));
      await userEvent.click(within(dialog).getByRole("button", { name: /^delete$/i }));

      await waitFor(async () => expect(await localBranchNames(dir)).not.toContain(LONG_BRANCH));
      // Real UI: the now-deleted branch's chip is gone from the row.
      await waitFor(() => {
        expect(
          within(row).queryByRole("img", { name: new RegExp(`local branch: ${LONG_BRANCH.replace(/\//g, "\\/")}$`) }),
        ).not.toBeInTheDocument();
      });
      // Delete never touched HEAD/current branch.
      expect(await currentBranchName(dir)).toBe("main");
    },
    30000,
  );

  it(
    "AC1: right-clicking the row's own graph area (not the chip) still opens the commit context menu — the chip's stopPropagation doesn't swallow ordinary row right-clicks",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "base\n", "only commit");

      await openAppOn(dir);
      const row = await rowFor("only commit");
      const subjectEl = within(row).getByText("only commit");
      fireEvent.contextMenu(subjectEl, { clientX: 20, clientY: 20 });

      const menu = await screen.findByRole("menu", { name: /Actions for commit/i });
      expect(within(menu).getByRole("menuitem", { name: /checkout commit/i })).toBeInTheDocument();
    },
    30000,
  );

  it(
    "AC2: a row with a real long branch name and a row with no refs at all reserve the exact same gutter width, keeping the subject column aligned",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "base\n", "no-ref commit");
      await commitFile(dir, "b.txt", "next\n", "ref commit");
      await git(dir, ["branch", LONG_BRANCH]); // tip is "ref commit" — HEAD/main share that tip too.

      await openAppOn(dir);
      const refRow = await rowFor("ref commit");
      const noRefRow = await rowFor("no-ref commit");

      const refGutter = refRow.querySelector(".gh-commit-row__refgutter") as HTMLElement;
      const noRefGutter = noRefRow.querySelector(".gh-commit-row__refgutter") as HTMLElement;
      expect(refGutter.style.width).toBe(`${REF_GUTTER_WIDTH}px`);
      expect(noRefGutter.style.width).toBe(`${REF_GUTTER_WIDTH}px`);
      // Genuinely no ref content on the older commit — not a hidden placeholder standing in.
      expect(noRefGutter.children.length).toBe(0);

      // Same paddingLeft on both rows — subject/author/date columns stay aligned regardless of
      // whether a given row happens to carry a ref chip.
      expect((refRow as HTMLElement).style.paddingLeft).toBe((noRefRow as HTMLElement).style.paddingLeft);
    },
    30000,
  );

  it(
    "AC3: real for-each-ref decorations (local branch + tag + remote-tracking branch + detached HEAD) render distinct glyph classes with no inline color anywhere on the chip, in both themes",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      // specs/ref-chip-gutter-legibility.md FR-408: each ref decoration lands on its OWN commit
      // here, so no row ever carries 2+ chips — this test is specifically about glyph SHAPE
      // distinctness (FR-406/AC9's DOM-level companion), not the multi-chip collapse feature
      // (covered separately in App.refChipCollapse.e2e.test.tsx); a collapsed row would hide all
      // but one glyph behind the "+N" affix and this test would no longer see all four at once.
      const detachSha = await commitFile(dir, "a.txt", "base\n", "detach target commit");
      await commitFile(dir, "b.txt", "tag\n", "tag commit");
      await git(dir, ["tag", "v1.0"]);
      const remoteSha = await commitFile(dir, "c.txt", "remote\n", "remote-tracked commit");
      await git(dir, ["update-ref", "refs/remotes/origin/feature", remoteSha]);
      await commitFile(dir, "d.txt", "main tip\n", "main tip commit");
      await git(dir, ["checkout", "-q", detachSha]); // detach HEAD on its own ref-less commit.

      await openAppOn(dir);
      // specs/commit-graph.md FR-15: a remote-tracking branch is hidden by default unless it's the
      // current branch's own upstream (refFiltering.ts) — this synthetic ref isn't, so "Show all
      // branches & tags" (Find Commits overlay) must be turned on for it to render at all. Escape
      // afterwards only clears the SHA/author/date filter fields (`closeFindCommits`), never this
      // toggle, so it stays applied for the rest of the test.
      await userEvent.click(screen.getByRole("button", { name: "Find commits" }));
      await userEvent.click(await screen.findByRole("checkbox", { name: /show all branches & tags/i }));
      await userEvent.keyboard("{Escape}");

      const tagRow = await rowFor("tag commit");
      const remoteRow = await rowFor("remote-tracked commit");
      const branchRow = await rowFor("main tip commit");
      const headRow = await rowFor("detach target commit");

      const tagChip = within(tagRow).getByRole("img", { name: /tag: v1\.0/i });
      const remoteChip = within(remoteRow).getByRole("img", { name: /remote branch: origin\/feature/i });
      const branchChip = within(branchRow).getByRole("img", { name: /local branch: main/i });
      const headChip = within(headRow).getByRole("img", { name: /HEAD \(detached\)/i });

      for (const chip of [branchChip, tagChip, remoteChip, headChip]) {
        expect(chip.getAttribute("style")).toBeNull();
      }
      // Type is conveyed by glyph shape (a literal icon per type, specs/ref-chip-gutter-redesign.md
      // FR-416 — the old dot/ring/diamond/square CSS-drawn glyphs are gone), not color: four
      // visibly distinct, real SVG icons.
      expect(tagRow.querySelector("svg[data-ref-icon='tag']")).not.toBeNull();
      expect(remoteRow.querySelector("svg[data-ref-icon='remote-branch']")).not.toBeNull();
      expect(branchRow.querySelector("svg[data-ref-icon='local-branch']")).not.toBeNull();
      expect(headRow.querySelector("svg[data-ref-icon='head']")).not.toBeNull();
      expect(headChip.className).toContain("gh-refchip--detached");
      // FR-408: none of these single-ref rows collapse — no "+N" affix anywhere on any of them.
      for (const row of [tagRow, remoteRow, branchRow, headRow]) {
        expect(within(row).queryByRole("button", { name: /more refs on this commit/i })).not.toBeInTheDocument();
      }

      // Toggling the theme changes only the CSS custom-property values (theme.css), never adds an
      // inline color to the chip itself. toolbar-action-row redesign: the theme toggle moved
      // permanently into the toolbar's "⋯" overflow menu.
      await userEvent.click(screen.getByRole("button", { name: /more actions/i }));
      await userEvent.click(screen.getByRole("menuitem", { name: /switch to light theme/i }));
      await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
      for (const chip of [branchChip, tagChip, remoteChip, headChip]) {
        expect(chip.getAttribute("style")).toBeNull();
      }
    },
    30000,
  );

  it(
    "AC4: GraphCanvas's lane art starts exactly at REF_GUTTER_WIDTH — no gap or overlap with the ref-chip gutter column, even with multiple real lanes from a real merge",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "base\n", "base commit");
      await git(dir, ["checkout", "-q", "-b", "topic"]);
      await commitFile(dir, "b.txt", "topic\n", "topic commit");
      await git(dir, ["checkout", "-q", "main"]);
      await commitFile(dir, "a.txt", "base v2\n", "main commit");
      await git(dir, ["merge", "--no-ff", "-q", "-m", "merge topic", "topic"]);

      await openAppOn(dir);
      await rowFor("merge topic"); // real multi-lane graph rendered.

      const scroller = await graphRegion();
      const canvas = scroller.querySelector(".gh-graph-canvas") as HTMLElement;
      expect(canvas).not.toBeNull();
      expect(canvas.style.left).toBe(`${REF_GUTTER_WIDTH}px`);

      // Every real row's own content offset starts at REF_GUTTER_WIDTH + the same graph width the
      // canvas was sized with — the graph art (0..graphWidth, offset by REF_GUTTER_WIDTH) never
      // overlaps the row's own text content, and there's no unaccounted gap between them either.
      const rows = scroller.querySelectorAll(".gh-commit-row");
      expect(rows.length).toBeGreaterThan(0);
      const paddings = new Set(Array.from(rows).map((r) => (r as HTMLElement).style.paddingLeft));
      expect(paddings.size).toBe(1); // one consistent offset shared by every row and the canvas.
      const graphWidthPx = Number(paddings.values().next().value!.replace("px", "")) - REF_GUTTER_WIDTH;
      expect(graphWidthPx).toBeGreaterThan(0); // this repo really does have >1 lane on screen.
    },
    30000,
  );
});
