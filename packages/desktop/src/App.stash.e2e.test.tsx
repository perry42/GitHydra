import { afterEach, describe, expect, it } from "vitest";
import { configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import {
  addWorktree,
  cleanup,
  commitAll,
  git,
  initRepo,
  readFile,
  stashList,
  statusPorcelain,
  writeFile,
} from "./test/gitFixture";

// This suite drives real `git` child-process spawns (via the real `RepoSession`/`Repository`
// stack — see `./test/realGitHydraApi.ts`) underneath every `waitFor`, which is meaningfully
// slower than the in-memory-mock `GitHydraApi` the rest of the desktop suite uses — RTL's default
// 1000ms `waitFor` timeout is too tight for that and produces flaky, environment-dependent
// failures rather than real assertion failures. Scoped to this file only (vitest gives each test
// file its own module registry).
configure({ asyncUtilTimeout: 12000 });

/**
 * specs/stash.md — the acceptance-criteria sweep this spec's own hand-off notes call out as
 * needing the REAL running app, not a mocked `window.gitHydra` (AC7's watcher-triggered alert,
 * AC16's two-worktree scenario, AC18's 5+-consecutive-self-write staleness check, and every
 * "does the UI correctly reflect what git-core actually did" flow crossing the UI/git-core
 * boundary). Every test here renders the REAL `<App/>` component tree against a REAL `GitHydraApi`
 * backed by a REAL `RepoSession`/`Repository` shelling out to a REAL `git` binary against a REAL
 * temp repo on disk (`./test/realGitHydraApi.ts`) — no git-core mocking anywhere in this file.
 *
 * Each test opens its own independent temp repo (no shared fixture state, no ordering dependency).
 */

const handles: RealGitHydraHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  // A short grace window before disposing: App.tsx's own FR-101 refresh calls (`refreshRefs`/
  // `refreshStashList`/`refreshWorkingDirStatus`) are deliberately fire-and-forget (`void
  // graph.refreshXxx()`), matching production — a real background `git` spawn one of them kicked
  // off can still be in flight the instant this test's own assertions finish. Giving it a beat to
  // settle before `dispose()` tears down the session avoids a harmless-but-noisy "No repository is
  // open" rejection racing this test's own teardown; it does not affect what any test asserts.
  await new Promise((resolve) => setTimeout(resolve, 350));
  while (handles.length) handles.pop()!.dispose();
  while (dirs.length) await cleanup(dirs.pop()!);
});

async function openAppOn(dir: string): Promise<RealGitHydraHandle> {
  const handle = createRealGitHydraApi();
  handles.push(handle);
  handle.setDialogPath(dir);
  window.gitHydra = handle.api;
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: /open repository/i }));
  // Every fresh repo in this suite starts with at least one commit already made (see each test's
  // own setup) — waiting for the Stashes toggle to appear is a reliable "app finished opening"
  // signal that doesn't depend on any particular commit subject text.
  await screen.findByRole("button", { name: /stashes/i }, { timeout: 10000 });
  return handle;
}

async function openStashPanel(): Promise<HTMLElement> {
  const toggle = await screen.findByRole("button", { name: /^stashes/i });
  await userEvent.click(toggle);
  return screen.findByRole("complementary", { name: "Stashes" });
}

/**
 * After an Apply/Pop click, waits for the row's own "Working…" busy state to clear — a real
 * UI-observable signal (`useStashActions.ts`'s `busyIndex`, rendered by `StashPanel.tsx`) that the
 * underlying IPC round trip actually settled — then confirms no error surfaced. `busyIndex` clears
 * in a `finally` on BOTH success and failure/conflict (it signals "round trip settled", not "it
 * succeeded"), so the no-alert check closes that gap. `scope` should be the stash panel (or a
 * narrower element within it, e.g. a single row) so this doesn't pick up an unrelated `role="alert"`
 * elsewhere on the page (e.g. the external-changes staleness banner).
 */
async function waitForStashActionSettled(scope: HTMLElement): Promise<void> {
  await waitFor(() => expect(within(scope).queryByRole("button", { name: /working/i })).not.toBeInTheDocument());
  expect(within(scope).queryByRole("alert")).not.toBeInTheDocument();
}

/**
 * `StashPanel`'s stash-row list AND its diff column's per-file list both render `<li>` elements
 * inside the same `complementary` landmark (FR-95's two-region split) — a bare
 * `within(stashPanel).getAllByRole("listitem")` ambiguously matches both. Scope to the actual
 * `<ul class="gh-stash-panel__list">` stash-row container specifically.
 */
function stashRows(stashPanel: HTMLElement): HTMLElement[] {
  const list = stashPanel.querySelector(".gh-stash-panel__list");
  if (!list) return [];
  return within(list as HTMLElement).getAllByRole("listitem");
}

const externalBanner = () => screen.queryByText(/history changed outside gitHydra/i);

describe("specs/stash.md — real App + real git-core integration", () => {
  it(
    "AC1/AC9/AC19: create (all files, no message) -> apply -> Toolbar badge, ChangesPanel, and stash list all refresh with no restart",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "base\n");
      await commitAll(dir, "base");
      await writeFile(dir, "a.txt", "changed\n");

      await openAppOn(dir);
      const stashPanel = await openStashPanel();

      await userEvent.click(within(stashPanel).getByRole("button", { name: /new stash/i }));
      const dialog = await screen.findByRole("dialog");
      await userEvent.click(await within(dialog).findByRole("button", { name: /create stash/i }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      // AC1: real git status is clean immediately afterward.
      await waitFor(async () => expect(await statusPorcelain(dir)).toBe(""));
      // AC1: a real `git stash list` entry exists, with git's own default message.
      const list = await stashList(dir);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatch(/WIP on main/);

      // AC19/FR-101: the Toolbar's badge and StashPanel's own list reflect it without a restart.
      await waitFor(() => expect(screen.getByRole("button", { name: /^stashes, 1$/i })).toBeInTheDocument());
      await waitFor(() => expect(within(stashPanel).getByText(/WIP on main/)).toBeInTheDocument());

      // Now Apply it, and confirm the full refresh contract crosses back into the real UI: the
      // Toolbar's stash badge is unchanged (apply keeps the entry), ChangesPanel shows the
      // restored file, and no restart/manual refresh was needed for any of it.
      await userEvent.click(within(stashPanel).getByRole("button", { name: /^apply$/i }));
      await waitForStashActionSettled(stashPanel);
      await waitFor(async () => expect(await statusPorcelain(dir)).not.toBe(""));
      // AC9: apply leaves the entry present in `git stash list`.
      expect(await stashList(dir)).toHaveLength(1);
      expect(screen.getByRole("button", { name: /^stashes, 1$/i })).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /^changes/i }));
      const changesPanel = await screen.findByRole("complementary", { name: /changes/i });
      await waitFor(() => expect(within(changesPanel).getAllByText("a.txt").length).toBeGreaterThan(0));
    },
    30000,
  );

  it(
    "AC10: Pop on a cleanly-applicable stash applies its changes AND removes exactly that entry (list length -1)",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "base\n");
      await commitAll(dir, "base");
      await writeFile(dir, "a.txt", "changed\n");
      await git(dir, ["stash", "push", "-m", "existing stash"]);
      await writeFile(dir, "a.txt", "changed again\n");

      await openAppOn(dir);
      const stashPanel = await openStashPanel();
      await userEvent.click(within(stashPanel).getByRole("button", { name: /new stash/i }));
      const dialog = await screen.findByRole("dialog");
      await userEvent.click(await within(dialog).findByRole("button", { name: /create stash/i }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() => expect(within(stashPanel).getAllByRole("button", { name: /^pop$/i })).toHaveLength(2));

      const rows = stashRows(stashPanel);
      const topRow = rows[0]!;
      await userEvent.click(within(topRow).getByRole("button", { name: /^pop$/i }));

      await waitFor(async () => expect(await stashList(dir)).toHaveLength(1));
      expect((await stashList(dir))[0]).toMatch(/existing stash/);
      await waitFor(() => expect(stashRows(stashPanel)).toHaveLength(1));
      expect(within(stashPanel).getByText(/existing stash/)).toBeInTheDocument();
    },
    30000,
  );

  it(
    "AC2: creating a stash from only a subset of files leaves the unselected file's changes untouched, and `git stash show` touches only the selected path",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "base a\n");
      await writeFile(dir, "b.txt", "base b\n");
      await commitAll(dir, "base");
      await writeFile(dir, "a.txt", "changed a\n");
      await writeFile(dir, "b.txt", "changed b\n");

      await openAppOn(dir);
      const stashPanel = await openStashPanel();
      await userEvent.click(within(stashPanel).getByRole("button", { name: /new stash/i }));
      const dialog = await screen.findByRole("dialog");
      await within(dialog).findByLabelText(/message/i); // wait for the file list to finish loading.
      // Uncheck b.txt, leave a.txt checked (both default-checked per FR-99).
      const bCheckbox = within(dialog).getByText("b.txt").closest("label")!.querySelector("input")!;
      await userEvent.click(bCheckbox);
      await userEvent.click(await within(dialog).findByRole("button", { name: /create stash/i }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      await waitFor(async () => expect(await statusPorcelain(dir)).toContain("b.txt"));
      const status = await statusPorcelain(dir);
      expect(status).not.toContain("a.txt"); // a.txt was stashed away.
      expect(status).toContain(" M b.txt"); // b.txt's change is untouched in the working tree.

      const { stdout: shown } = await git(dir, ["stash", "show", "--name-only", "stash@{0}"]);
      expect(shown.trim()).toBe("a.txt");
    },
    30000,
  );

  it(
    "AC3: with 'Include untracked files' left unchecked (git's own default), create is disabled when only an untracked file is present, and that file is left untracked if the dialog is dismissed",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "base\n");
      await commitAll(dir, "base");
      await writeFile(dir, "untracked.txt", "new stuff\n");

      await openAppOn(dir);
      const stashPanel = await openStashPanel();
      await userEvent.click(within(stashPanel).getByRole("button", { name: /new stash/i }));
      const dialog = await screen.findByRole("dialog");

      // Nothing ELSE is eligible in this repo (a.txt has no changes), so with the untracked
      // checkbox left off (git's own default, FR-99), create is correctly disabled.
      expect(await within(dialog).findByRole("button", { name: /create stash/i })).toBeDisabled();
      await userEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
      expect(await statusPorcelain(dir)).toContain("?? untracked.txt");
    },
    25000,
  );

  it(
    "AC3: 'Include untracked files' checked captures the untracked file — verified via the stash's own untracked-capture commit (`stash@{0}^3`) and by popping it back",
    async () => {
      // Note: this repo's installed git (2.31.1) does not reliably surface untracked-captured
      // files through `git stash show -u --name-only` (verified directly against the real CLI —
      // it only prints the tracked file even with `-u`/`--include-untracked` passed), so this
      // test verifies the untracked capture the same way `getStashDiff()` itself does (git-core's
      // `stash.ts`, FR-83): the stash's own third parent (present only for an
      // `--include-untracked` stash) is a real commit whose tree is exactly the captured
      // untracked files — plus the behavioral ground truth that popping restores the file as
      // untracked on disk again.
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "base\n");
      await commitAll(dir, "base");
      await writeFile(dir, "a.txt", "changed\n");
      await writeFile(dir, "untracked.txt", "new stuff\n");

      await openAppOn(dir);
      const stashPanel = await openStashPanel();
      await userEvent.click(within(stashPanel).getByRole("button", { name: /new stash/i }));
      const dialog2 = await screen.findByRole("dialog");
      await within(dialog2).findByLabelText(/include untracked/i);
      await userEvent.click(within(dialog2).getByLabelText(/include untracked/i));
      await userEvent.click(await within(dialog2).findByRole("button", { name: /create stash/i }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      await waitFor(async () => expect(await statusPorcelain(dir)).toBe(""));
      const { stdout } = await git(dir, ["show", "--name-only", "--format=", "stash@{0}^3"]);
      expect(stdout.trim().split("\n")).toContain("untracked.txt");

      await userEvent.click(await within(stashPanel).findByRole("button", { name: /^pop$/i }));
      await waitFor(() => expect(within(stashPanel).queryByRole("button", { name: /working/i })).not.toBeInTheDocument());
      await waitFor(async () => expect(await statusPorcelain(dir)).toContain("?? untracked.txt"));
    },
    30000,
  );

  it(
    "AC4: a custom message is shown by `git stash list` verbatim, never git's default WIP message",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "base\n");
      await commitAll(dir, "base");
      await writeFile(dir, "a.txt", "changed\n");

      await openAppOn(dir);
      const stashPanel = await openStashPanel();
      await userEvent.click(within(stashPanel).getByRole("button", { name: /new stash/i }));
      const dialog = await screen.findByRole("dialog");
      await userEvent.type(await within(dialog).findByLabelText(/message/i), "非ASCII: hold this for later 🚀");
      await userEvent.click(await within(dialog).findByRole("button", { name: /create stash/i }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      await waitFor(async () => {
        const list = await stashList(dir);
        expect(list[0]).toContain("非ASCII: hold this for later 🚀");
      });
      await waitFor(() => expect(within(stashPanel).getByText("非ASCII: hold this for later 🚀")).toBeInTheDocument());
    },
    30000,
  );

  it(
    "AC5: with a clean working tree, the create action is disabled with a stated reason and produces no stash entry",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "base\n");
      await commitAll(dir, "base");

      await openAppOn(dir);
      const stashPanel = await openStashPanel();
      const newStashButton = within(stashPanel).getByRole("button", { name: /new stash/i });
      expect(newStashButton).toBeDisabled();
      expect(newStashButton).toHaveAttribute("title", expect.stringMatching(/no changes to stash/i));
      expect(await stashList(dir)).toHaveLength(0);
    },
    25000,
  );

  it(
    "AC6: on a zero-commit (unborn HEAD) repository, stash creation is disabled with an explicit message rather than crashing",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "content\n");

      await openAppOn(dir);
      const stashToggle = screen.getByRole("button", { name: /^stashes/i });
      expect(stashToggle).not.toBeDisabled(); // the toggle itself opens fine even on unborn HEAD.
      await userEvent.click(stashToggle);
      const stashPanel = await screen.findByRole("complementary", { name: "Stashes" });
      const newStashButton = within(stashPanel).getByRole("button", { name: /new stash/i });
      expect(newStashButton).toBeDisabled();
      expect(newStashButton).toHaveAttribute("title", expect.stringMatching(/no commits yet/i));
    },
    25000,
  );

  it(
    "AC8: selecting a stash previews its diff (including a captured untracked file) without altering `git status --porcelain` before or after",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "base\n");
      await commitAll(dir, "base");
      await writeFile(dir, "a.txt", "changed\n");
      await writeFile(dir, "untracked.txt", "extra\n");
      await git(dir, ["stash", "push", "-u", "-m", "preview me"]);

      const beforeStatus = await statusPorcelain(dir);
      expect(beforeStatus).toBe("");

      await openAppOn(dir);
      const stashPanel = await openStashPanel();
      await waitFor(() => expect(within(stashPanel).getAllByText(/a\.txt/).length).toBeGreaterThan(0));
      await waitFor(() => expect(within(stashPanel).getByText(/untracked\.txt/)).toBeInTheDocument());
      expect(within(stashPanel).getByText(/untracked\.txt/).textContent).toMatch(/untracked/i);

      expect(await statusPorcelain(dir)).toBe(beforeStatus);
    },
    30000,
  );

  it(
    "AC11/AC12: a conflicting Apply leaves the stash listed, opens ChangesPanel's Conflicted section with the FR-98 notice, shows no merge/rebase operation banner or Continue/Abort, and Accept Ours resolves it",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "line1\nline2\nline3\n");
      await commitAll(dir, "base");
      await writeFile(dir, "a.txt", "stashed change\nline2\nline3\n");
      await git(dir, ["stash", "push", "-m", "conflicting stash"]);
      // A real 3-way-merge CONFLICT (not just a "would be overwritten" refusal — see this test's
      // hand-off notes) requires the tip the stash is re-applied against to have genuinely
      // diverged via its own commit, touching the SAME line the stash itself touched.
      await writeFile(dir, "a.txt", "committed change\nline2\nline3\n");
      await commitAll(dir, "diverge");

      await openAppOn(dir);
      const stashPanel = await openStashPanel();
      await waitFor(() => expect(within(stashPanel).getByRole("button", { name: /^apply$/i })).toBeInTheDocument());
      await userEvent.click(within(stashPanel).getByRole("button", { name: /^apply$/i }));

      // FR-98 notice + Conflicted section, surfaced via ChangesPanel (App switches to it on conflict).
      const changesPanel = await screen.findByRole("complementary", { name: /changes/i });
      await waitFor(() =>
        expect(within(changesPanel).getByText(/applying stash left conflicts to resolve/i)).toBeInTheDocument(),
      );
      expect(within(changesPanel).getByText(/the stash was not removed from the list/i)).toBeInTheDocument();

      // AC11: no merge/rebase-style operation banner or Continue/Abort — this is not an in-progress operation.
      expect(screen.queryByRole("button", { name: /^continue$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^abort$/i })).not.toBeInTheDocument();

      // AC11: the stash entry remains in `git stash list` despite the conflict.
      expect(await stashList(dir)).toHaveLength(1);

      // AC12: Accept Ours works exactly like a merge conflict's equivalent action.
      await userEvent.click(within(changesPanel).getAllByText("a.txt")[0]!);
      // No in-progress-operation state exists for a stash conflict (per FR-86/the module's "sharp
      // edge" doc comment), so `getConflictSideLabels()` returns null and the button falls back to
      // `acceptActionLabel`'s generic "our side"/"their side" wording, NOT the merge/rebase-style
      // "Your branch"/"Incoming" labels — itself a small, real confirmation that this path is
      // correctly NOT treated as an in-progress operation.
      const acceptOurs = await screen.findByRole("button", { name: /accept our side/i });
      await userEvent.click(acceptOurs);

      await waitFor(async () => {
        const status = await statusPorcelain(dir);
        expect(status).not.toMatch(/^UU/m);
      });
    },
    35000,
  );

  it(
    "AC11: a conflicting Pop ALSO leaves the stash entry in the list (matches git's real pop-never-drops-on-conflict behavior)",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "line1\nline2\nline3\n");
      await commitAll(dir, "base");
      await writeFile(dir, "a.txt", "stashed change\nline2\nline3\n");
      await git(dir, ["stash", "push", "-m", "conflicting stash"]);
      await writeFile(dir, "a.txt", "committed change\nline2\nline3\n");
      await commitAll(dir, "diverge");

      await openAppOn(dir);
      const stashPanel = await openStashPanel();
      await waitFor(() => expect(within(stashPanel).getByRole("button", { name: /^pop$/i })).toBeInTheDocument());
      await userEvent.click(within(stashPanel).getByRole("button", { name: /^pop$/i }));

      await screen.findByText(/popping stash left conflicts to resolve/i);
      expect(await stashList(dir)).toHaveLength(1);
    },
    30000,
  );

  it(
    "AC13: Drop routes through ConfirmDialog — canceling leaves every stash untouched; confirming removes exactly the targeted stash@{N}",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "base\n");
      await commitAll(dir, "base");
      await writeFile(dir, "a.txt", "v1\n");
      await git(dir, ["stash", "push", "-m", "stash A"]);
      await writeFile(dir, "a.txt", "v2\n");
      await git(dir, ["stash", "push", "-m", "stash B"]);

      await openAppOn(dir);
      const stashPanel = await openStashPanel();
      await waitFor(() => expect(within(stashPanel).getAllByRole("button", { name: /^drop$/i })).toHaveLength(2));

      // stash@{0} is "stash B" (most recent) — drop it, canceling first.
      const rows = stashRows(stashPanel);
      await userEvent.click(within(rows[0]!).getByRole("button", { name: /^drop$/i }));
      const cancelDialog = await screen.findByRole("alertdialog");
      expect(cancelDialog).toHaveTextContent(/stash B/);
      await userEvent.click(within(cancelDialog).getByRole("button", { name: /cancel/i }));
      expect(await stashList(dir)).toHaveLength(2);

      await userEvent.click(within(rows[0]!).getByRole("button", { name: /^drop$/i }));
      const confirmDialog = await screen.findByRole("alertdialog");
      await userEvent.click(within(confirmDialog).getByRole("button", { name: /^drop$/i }));

      await waitFor(async () => expect(await stashList(dir)).toHaveLength(1));
      expect((await stashList(dir))[0]).toMatch(/stash A/);
    },
    30000,
  );

  it(
    "AC14: applying a stash while on a different branch than the one named in its message succeeds with no gate, and the panel names the ORIGINAL branch throughout",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "base\n");
      await commitAll(dir, "base");
      await writeFile(dir, "a.txt", "on main\n");
      // No custom message — git's own default `WIP on main: <sha> ...` is the ONLY message shape
      // this module ever parses a branch name out of (`parseStashSubject`'s doc comment).
      await git(dir, ["stash", "push"]);
      await git(dir, ["checkout", "-q", "-b", "other-branch"]);

      await openAppOn(dir);
      const stashPanel = await openStashPanel();
      await waitFor(() => expect(within(stashPanel).getByText(/WIP on main/i)).toBeInTheDocument());
      // The row's own caption still names "main" even though the app currently has "other-branch"
      // checked out.
      const row = within(stashPanel).getByText(/WIP on main/i).closest("li")!;
      expect(within(row).getByText("main")).toBeInTheDocument();

      await userEvent.click(within(row).getByRole("button", { name: /^apply$/i }));
      await waitForStashActionSettled(stashPanel);
      // Precise, single confirming read: the stashed content ("on main\n", written at repo setup
      // above) is back in a.txt, rather than a generic non-empty-porcelain poll that would also
      // pass on an unrelated dirtying of the tree. Normalize CRLF->LF first: a real git checkout of
      // this blob is subject to the environment's own `core.autocrlf` (e.g. commonly `true` on
      // Windows), which is git's own well-defined behavior, not something this test is about.
      await waitFor(async () => expect((await readFile(dir, "a.txt")).replace(/\r\n/g, "\n")).toBe("on main\n"));
      // No dialog/gate of any kind interrupted the click above.
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    },
    30000,
  );

  it(
    "AC15: on a bare repository, the Toolbar's stash toggle, panel, and every action are disabled with an explicit reason",
    async () => {
      const dir = await initRepo({ bare: true });
      dirs.push(dir);

      const handle = createRealGitHydraApi();
      handles.push(handle);
      handle.setDialogPath(dir);
      window.gitHydra = handle.api;
      render(<App />);
      await userEvent.click(screen.getByRole("button", { name: /open repository/i }));

      const stashToggle = await screen.findByRole("button", { name: /^stashes/i }, { timeout: 10000 });
      expect(stashToggle).toBeDisabled();
      expect(stashToggle).toHaveAttribute("title", expect.stringMatching(/no working directory/i));
    },
    25000,
  );

  it(
    "AC16: a stash created via worktree A's session is visible from worktree B's session once refreshed, and applying it from B affects only B's working tree",
    async () => {
      const mainDir = await initRepo();
      dirs.push(mainDir);
      await writeFile(mainDir, "a.txt", "base\n");
      await commitAll(mainDir, "base");
      const worktreeB = await addWorktree(mainDir, "wt-b");
      dirs.push(worktreeB);

      // "Worktree A" is the main worktree itself — this is a real `git stash push` run directly
      // against it (simulating a user's action in tab A), not routed through the test's own App
      // instance at all, so this test is really about B's real, independent visibility/effect.
      await writeFile(mainDir, "a.txt", "changed in A\n");
      await git(mainDir, ["stash", "push", "-m", "from worktree A"]);

      const handle = await openAppOn(worktreeB);
      const stashPanelB = await openStashPanel();
      // FR-82: visible from B once refreshed/reactivated.
      await waitFor(() => expect(within(stashPanelB).getByText(/from worktree a/i)).toBeInTheDocument());

      await userEvent.click(within(stashPanelB).getByRole("button", { name: /^apply$/i }));
      await waitForStashActionSettled(stashPanelB);
      await waitFor(async () => expect(await statusPorcelain(worktreeB)).not.toBe(""));

      // Applying from B must not touch A's own working tree.
      const statusA = await statusPorcelain(mainDir);
      expect(statusA).toBe("");
      void handle;
    },
    30000,
  );

  it(
    "AC7: a stash created from a separate terminal while GitHydra is open and idle triggers the ordinary external-change alert",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "base\n");
      await commitAll(dir, "base");

      await openAppOn(dir);
      expect(externalBanner()).not.toBeInTheDocument();

      // A separate process/terminal stashes something, entirely outside this app's own IPC calls.
      await writeFile(dir, "a.txt", "external change\n");
      await git(dir, ["stash", "push", "-m", "from another terminal"]);

      await waitFor(() => expect(externalBanner()).toBeInTheDocument(), { timeout: 10000 });

      // Acknowledging it (the banner's own Refresh button, not the Toolbar's separate manual
      // refresh) picks the new entry up in the Stash panel.
      const bannerAlert = screen.getByText(/history changed outside gitHydra/i).closest('[role="alert"]')!;
      await userEvent.click(within(bannerAlert as HTMLElement).getByRole("button", { name: /refresh/i }));
      await waitFor(() => expect(externalBanner()).not.toBeInTheDocument());
      const stashPanel = await openStashPanel();
      await waitFor(() => expect(within(stashPanel).getByText(/from another terminal/i)).toBeInTheDocument());
    },
    30000,
  );

  it(
    "AC18: 5 consecutive stash operations from the app itself never show the external-changes staleness banner",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "base\n");
      await commitAll(dir, "base");
      // GitHydra only watches git metadata (refs/stash, HEAD, etc.) for external changes — it does
      // not poll the whole working tree, so a plain file edit made *outside* its own IPC calls is
      // (correctly) invisible until an explicit refresh. To keep this test about FR-92's
      // self-write gate (not that unrelated, correct behavior), the SAME already-known change is
      // create/pop'd 5 times in a row: pop's own FR-101 refresh re-surfaces it as a real,
      // app-known unstaged change each time, so "New Stash" stays legitimately enabled throughout.
      await writeFile(dir, "a.txt", "change\n");

      await openAppOn(dir);
      const stashPanel = await openStashPanel();

      for (let i = 0; i < 5; i++) {
        await waitFor(() => expect(within(stashPanel).getByRole("button", { name: /new stash/i })).not.toBeDisabled());
        await userEvent.click(within(stashPanel).getByRole("button", { name: /new stash/i }));
        const dialog = await screen.findByRole("dialog");
        await userEvent.click(await within(dialog).findByRole("button", { name: /create stash/i }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        await waitFor(async () => expect(await stashList(dir)).toHaveLength(1));
        await waitFor(() => expect(within(stashPanel).getByRole("button", { name: /^pop$/i })).toBeInTheDocument());

        await userEvent.click(within(stashPanel).getByRole("button", { name: /^pop$/i }));
        await waitFor(async () => expect(await stashList(dir)).toHaveLength(0));

        expect(externalBanner()).not.toBeInTheDocument();
      }
    },
    50000,
  );

  it(
    "edge case: getStashDiff's per-file diff surfaces diff.ts's real 'too-large' guard for a file over the default size threshold",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "small.txt", "tiny\n");
      await commitAll(dir, "base");
      // Over DEFAULT_MAX_FILE_SIZE_BYTES (2MB) — a real file, not a mocked diff result.
      const big = "x".repeat(3 * 1024 * 1024);
      await writeFile(dir, "big.bin.txt", big);
      await git(dir, ["stash", "push", "-u", "-m", "has a huge file"]);

      await openAppOn(dir);
      const stashPanel = await openStashPanel();
      await waitFor(() => expect(within(stashPanel).getAllByText(/big\.bin\.txt/i).length).toBeGreaterThan(0));
      await userEvent.click(within(stashPanel).getAllByText(/big\.bin\.txt/i)[0]!);

      await waitFor(() =>
        expect(within(stashPanel).getByText(/too large to display|file is too large/i)).toBeInTheDocument(),
      );
    },
    30000,
  );

  it(
    "edge case: rapidly requesting a second create before the first one's UI update settles still ends with exactly two correct, distinct stash entries",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "base\n");
      await writeFile(dir, "b.txt", "base\n");
      await commitAll(dir, "base");
      await writeFile(dir, "a.txt", "change 1\n");

      await openAppOn(dir);
      const stashPanel = await openStashPanel();
      await userEvent.click(within(stashPanel).getByRole("button", { name: /new stash/i }));
      const dialog1 = await screen.findByRole("dialog");
      await userEvent.click(await within(dialog1).findByRole("button", { name: /create stash/i }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      // Immediately queue a second stash's worth of changes and open the dialog again without
      // deliberately waiting for the first mutation's own refresh to visibly settle first.
      await writeFile(dir, "b.txt", "change 2\n");
      await waitFor(async () => expect(await stashList(dir)).toHaveLength(1));
      await userEvent.click(within(stashPanel).getByRole("button", { name: /new stash/i }));
      const dialog2 = await screen.findByRole("dialog");
      await userEvent.click(await within(dialog2).findByRole("button", { name: /create stash/i }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      await waitFor(async () => expect(await stashList(dir)).toHaveLength(2));
      const list = await stashList(dir);
      // Both entries are real, distinct commits — no corruption/duplication/silent drop.
      expect(new Set(list)).toHaveProperty("size", 2);
      await waitFor(() => expect(stashRows(stashPanel)).toHaveLength(2));
    },
    30000,
  );
});
