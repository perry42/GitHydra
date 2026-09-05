import { afterEach, describe, expect, it } from "vitest";
import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import { cleanup, commitAll, git, initRepo, makeTempDir, writeFile } from "./test/gitFixture";

// Real `git` child-process spawns underneath every `waitFor`, same rationale as
// `App.stash.e2e.test.tsx` (RTL's default 1000ms timeout is too tight for that).
configure({ asyncUtilTimeout: 12000 });

/**
 * specs/cherry-pick.md — the acceptance-criteria sweep that needs the REAL running app, not a
 * mocked `window.gitHydra`: does clicking through the UI actually produce the correct real `git`
 * history (order, diffs, HEAD position), does a conflict opened from the UI resolve into a real
 * commit, does Abort really restore the exact pre-sequence HEAD SHA, etc. Every test here renders
 * the REAL `<App/>` component tree against a REAL `GitHydraApi` backed by a REAL
 * `RepoSession`/`Repository` shelling out to a REAL `git` binary against a REAL temp repo on disk
 * (`./test/realGitHydraApi.ts`) — no git-core mocking anywhere in this file. Outcomes are verified
 * both via the rendered UI and, independently, via direct `git log`/`git diff`/`git rev-parse`
 * shell calls run outside the app.
 *
 * Each test opens its own independent temp repo (no shared fixture state, no ordering dependency).
 */

const handles: RealGitHydraHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  // Same grace window App.stash.e2e.test.tsx uses before disposing — App.tsx's own fire-and-forget
  // FR-121 refresh calls can still be in flight the instant a test's assertions finish.
  await new Promise((resolve) => setTimeout(resolve, 350));
  while (handles.length) handles.pop()!.dispose();
  while (dirs.length) {
    const dir = dirs.pop()!;
    try {
      await cleanup(dir);
    } catch {
      // Best-effort: an occasional Windows file-lock (a just-exited real `git` child process
      // still releasing its handle) shouldn't fail this test's own assertions or cascade into
      // leaving the next test's DOM/handles in a bad state.
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

async function logSubjects(dir: string, n: number): Promise<string[]> {
  const { stdout } = await git(dir, ["log", "--format=%s", "-" + n]);
  return stdout.trim().split("\n");
}

async function hasCherryPickHead(dir: string): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"]);
    return true;
  } catch {
    return false;
  }
}

async function isDetached(dir: string): Promise<boolean> {
  try {
    await git(dir, ["symbolic-ref", "-q", "HEAD"]);
    return false;
  } catch {
    return true;
  }
}

const externalBanner = () => screen.queryByText(/history changed outside gitHydra/i);
const operationStaleAlert = () => screen.queryByText(/changed outside gitHydra.*click refresh/i);

/**
 * `StatusBanner`'s operation-in-progress copy (`describeInProgressOperation`) renders as several
 * SEPARATE sibling `<span>`s (e.g. `<span>Cherry-picking </span><span>sha</span><span>
 * "subject"</span><span> (1 more queued)</span>`) — RTL's `getByText`/`findByText` only matches a
 * given element's own DIRECT text-node children (`getNodeText`), not its full recursive
 * `textContent`, so a regex intended to span that whole phrase never matches ANY single element
 * there even though the phrase is visibly all on one line. These two helpers read `textContent`
 * directly instead, exactly like `App.stash.e2e.test.tsx`'s own established pattern of scoping to
 * a specific real DOM node rather than fighting RTL's text-matcher semantics for generated,
 * multi-span copy. Selectors are scoped to each banner's own distinguishing class combination
 * since both share the generic `gh-status-banner--operation` class simultaneously mid-sequence
 * (the main operation banner is `--serious`, the FR-118 empty-result notice is `--neutral`). */
function operationBannerText(): string {
  return document.querySelector(".gh-status-banner--serious.gh-status-banner--operation")?.textContent ?? "";
}
function emptyResultNoticeText(): string {
  return document.querySelector(".gh-status-banner--neutral.gh-status-banner--operation")?.textContent ?? "";
}
function operationBannerVisible(): boolean {
  return document.querySelector(".gh-status-banner--serious.gh-status-banner--operation") !== null;
}
async function waitForOperationBannerText(matcher: RegExp): Promise<void> {
  await waitFor(() => expect(operationBannerText()).toMatch(matcher));
}
async function waitForEmptyResultNoticeText(matcher: RegExp): Promise<void> {
  await waitFor(() => expect(emptyResultNoticeText()).toMatch(matcher));
}
async function waitForOperationBannerGone(): Promise<void> {
  await waitFor(() => expect(operationBannerVisible()).toBe(false));
}

/** Async (`findByRole`, not `getByRole`) — the commit graph's own row virtualization only
 * measures `containerHeight`/loads paginated rows inside a `useEffect` that runs after this
 * component's first commit, so a synchronous query issued the instant the "app is open" signal
 * fires can lose that race and see no `listbox` (or zero rendered rows) yet. */
async function graphRegion(): Promise<HTMLElement> {
  return screen.findByRole("listbox", { name: /commit graph/i });
}

/** Finds a commit row (by its exact subject text) within the commit graph specifically — avoids
 * ambiguity with the same subject text possibly also appearing in DetailPanel/ChangesPanel. Every
 * fixture below is deliberately built so each subject used with this helper is unique in the
 * graph at the moment it's called (see individual tests' comments where that took care to arrange). */
async function rowFor(subject: string): Promise<HTMLElement> {
  const graph = await graphRegion();
  const text = await within(graph).findByText(subject);
  const row = text.closest('[role="option"]');
  if (!row) throw new Error(`row not found for subject: ${subject}`);
  return row as HTMLElement;
}

/** `fireEvent`, not `userEvent.click` — `userEvent.click`'s second argument isn't `fireEvent`'s
 * event-init shape, so `{ ctrlKey: true }` passed to it is silently ignored (confirmed directly;
 * `CommitGraph.test.tsx`'s own FR-111 unit tests use exactly this same `fireEvent` technique for
 * ctrl/shift-click). */
async function ctrlClickRow(subject: string): Promise<void> {
  const row = await rowFor(subject);
  fireEvent.click(row, { ctrlKey: true });
}

async function rightClickRow(subject: string): Promise<HTMLElement> {
  const row = await rowFor(subject);
  fireEvent.contextMenu(row, { clientX: 20, clientY: 20 });
  return screen.findByRole("menu");
}

/** Unlike a conflicting stash apply/pop (FR-98, which explicitly switches `rightPanel` to
 * "changes"), a cherry-pick conflict does not auto-open the Changes panel — the operation banner
 * alone signals it (FR-117). The Toolbar's own toggle has to be clicked explicitly. */
async function openChangesPanel(): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole("button", { name: /^changes/i }));
  return screen.findByRole("complementary", { name: /changes/i });
}

async function cherryPickSingle(subject: string): Promise<void> {
  const menu = await rightClickRow(subject);
  const item = within(menu).getByRole("menuitem", { name: /^cherry-pick$/i });
  expect(item).not.toBeDisabled();
  await userEvent.click(item);
}

/** Mirrors `App.stash.e2e.test.tsx`'s identically-named helper — the reliable, non-disk-racing
 * confirmation that a conflicted file's resolution actually landed. */
async function waitForConflictResolutionSettled(scope: HTMLElement): Promise<void> {
  await waitFor(() => expect(within(scope).getByText(/this file is resolved/i)).toBeInTheDocument());
}

describe("specs/cherry-pick.md — real App + real git-core integration", () => {
  it(
    "AC1: a single clean cherry-pick from the context menu creates exactly one new commit whose diff matches the source, HEAD becoming that commit",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "base\n", "base");
      await git(dir, ["checkout", "-q", "-b", "feature"]);
      const featureSha = await commitFile(dir, "a.txt", "feature change\n", "feature change");
      await git(dir, ["checkout", "-q", "main"]);
      const beforeHead = await headSha(dir);

      await openAppOn(dir);
      await cherryPickSingle("feature change");

      await waitFor(async () => expect(await headSha(dir)).not.toBe(beforeHead));
      const newHead = await headSha(dir);
      expect(newHead).not.toBe(featureSha); // a NEW commit, not a fast-forward.
      const sourceDiff = await git(dir, ["show", featureSha, "--format=", "--"]);
      const newDiff = await git(dir, ["show", newHead, "--format=", "--"]);
      expect(newDiff.stdout).toBe(sourceDiff.stdout);

      await waitFor(async () => expect(within(await graphRegion()).getAllByText("feature change")).toHaveLength(2));
      // AC14: no false "history changed outside GitHydra"/operation-stale alert from its own action.
      expect(externalBanner()).not.toBeInTheDocument();
      expect(operationStaleAlert()).not.toBeInTheDocument();
    },
    30000,
  );

  it(
    "AC2/FR-114: a 3-commit multi-selection clicked in non-graph order is applied oldest-first, verified via git log matching each source commit's diff",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "base-a\n");
      await writeFile(dir, "b.txt", "base-b\n");
      await writeFile(dir, "c.txt", "base-c\n");
      await commitAll(dir, "base");
      await git(dir, ["checkout", "-q", "-b", "feature"]);
      const f1 = await commitFile(dir, "a.txt", "feature-a\n", "f1: change a.txt");
      await commitFile(dir, "b.txt", "feature-b\n", "f2: change b.txt");
      const f3 = await commitFile(dir, "c.txt", "feature-c\n", "f3: change c.txt");
      await git(dir, ["checkout", "-q", "main"]);

      await openAppOn(dir);
      // Click order is deliberately NOT graph order: f3, then f1, then f2.
      await ctrlClickRow("f3: change c.txt");
      await ctrlClickRow("f1: change a.txt");
      await ctrlClickRow("f2: change b.txt");
      const menu = await rightClickRow("f2: change b.txt"); // still part of the 2+ selection.
      const item = within(menu).getByRole("menuitem", { name: /cherry-pick 3 commits/i });
      await userEvent.click(item);

      await waitFor(async () =>
        expect(await logSubjects(dir, 3)).toEqual(["f3: change c.txt", "f2: change b.txt", "f1: change a.txt"]),
      );

      const { stdout: shasRaw } = await git(dir, ["log", "--format=%H", "-3"]);
      const [newestSha, , oldestSha] = shasRaw.trim().split("\n");
      const sourceDiff1 = await git(dir, ["show", f1, "--format=", "--"]);
      const newDiff1 = await git(dir, ["show", oldestSha!, "--format=", "--"]);
      expect(newDiff1.stdout).toBe(sourceDiff1.stdout);
      const sourceDiff3 = await git(dir, ["show", f3, "--format=", "--"]);
      const newDiff3 = await git(dir, ["show", newestSha!, "--format=", "--"]);
      expect(newDiff3.stdout).toBe(sourceDiff3.stdout);
    },
    30000,
  );

  it(
    "AC3: cherry-pick is refused while a merge is already in progress — the context-menu item is disabled with a reason, and no new CHERRY_PICK_HEAD/index state appears",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "line1\nline2\nline3\n", "base");
      await git(dir, ["checkout", "-q", "-b", "extra"]);
      await commitFile(dir, "extra.txt", "extra content\n", "extra commit");
      await git(dir, ["checkout", "-q", "main"]);
      await git(dir, ["checkout", "-q", "-b", "other"]);
      await commitFile(dir, "a.txt", "other change\nline2\nline3\n", "other change");
      await git(dir, ["checkout", "-q", "main"]);
      await commitFile(dir, "a.txt", "main change\nline2\nline3\n", "main change");
      await git(dir, ["merge", "other"]).catch(() => {}); // real, unresolved merge conflict.

      await openAppOn(dir);
      await waitForOperationBannerText(/merging/i);

      const menu = await rightClickRow("extra commit");
      const item = within(menu).getByRole("menuitem", { name: /^cherry-pick$/i });
      expect(item).toBeDisabled();
      expect(item).toHaveAttribute("title", expect.stringMatching(/already in progress/i));

      // No git call was made: still exactly the pre-existing merge's state, no cherry-pick state.
      expect(await hasCherryPickHead(dir)).toBe(false);
      const status = await git(dir, ["status", "--porcelain"]);
      expect(status.stdout).toMatch(/^UU a\.txt/m);
    },
    30000,
  );

  it(
    "AC4: a single-commit conflict opens the operation banner with cherry-pick-specific copy, populates ChangesPanel's Conflicted section, and opens ConflictResolutionView",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "line1\nline2\nline3\n", "base");
      await git(dir, ["checkout", "-q", "-b", "feature"]);
      const featureSha = await commitFile(dir, "a.txt", "feature change\nline2\nline3\n", "feature change");
      await git(dir, ["checkout", "-q", "main"]);
      await commitFile(dir, "a.txt", "main change\nline2\nline3\n", "main change");

      await openAppOn(dir);
      await cherryPickSingle("feature change");

      await waitForOperationBannerText(/cherry-picking/i);
      expect(operationBannerText()).toMatch(/feature change/i);
      expect(operationBannerText()).toMatch(new RegExp(featureSha.slice(0, 7)));

      const changesPanel = await openChangesPanel();
      await waitFor(() => expect(within(changesPanel).getByText("a.txt")).toBeInTheDocument());
      await userEvent.click(within(changesPanel).getByText("a.txt"));

      const conflictView = await screen.findByRole("region", { name: /resolve conflict in a\.txt/i });
      expect(await within(conflictView).findByRole("button", { name: /accept your branch/i })).toBeInTheDocument();
      expect(within(conflictView).getByRole("button", { name: /accept cherry-picking/i })).toBeInTheDocument();
    },
    30000,
  );

  it(
    "AC5/AC16: a 3-commit sequence pausing on the middle commit shows '1 more queued' matching sequencer state, and Continue completes the whole sequence with the refresh contract honored",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "base-a\n");
      await writeFile(dir, "b.txt", "base-b\n");
      await writeFile(dir, "c.txt", "base-c\n");
      await commitAll(dir, "base");
      await git(dir, ["checkout", "-q", "-b", "feature"]);
      await commitFile(dir, "a.txt", "feature-a\n", "f1: change a.txt");
      await commitFile(dir, "b.txt", "feature-b\n", "f2: change b.txt");
      await commitFile(dir, "c.txt", "feature-c\n", "f3: change c.txt");
      await git(dir, ["checkout", "-q", "main"]);
      await commitFile(dir, "b.txt", "main-b\n", "m1: change b.txt");

      await openAppOn(dir);
      await ctrlClickRow("f1: change a.txt");
      await ctrlClickRow("f2: change b.txt");
      await ctrlClickRow("f3: change c.txt");
      const menu = await rightClickRow("f3: change c.txt");
      await userEvent.click(within(menu).getByRole("menuitem", { name: /cherry-pick 3 commits/i }));

      // f1 already committed cleanly before the pause on f2.
      await waitFor(async () => expect((await logSubjects(dir, 1))[0]).toBe("f1: change a.txt"));
      await waitForOperationBannerText(/f2: change b\.txt/i);
      expect(operationBannerText()).toMatch(/1 more queued/i);

      // AC16: Toolbar's Changes badge reflects the live conflicted-file count with no restart.
      await waitFor(() => expect(screen.getByRole("button", { name: /changes, 1 pending/i })).toBeInTheDocument());

      const changesPanel = await openChangesPanel();
      await userEvent.click(await within(changesPanel).findByText("b.txt"));
      const conflictView = await screen.findByRole("region", { name: /resolve conflict in b\.txt/i });
      // Accept *theirs* (the incoming cherry-picked change), not ours: accepting ours here would
      // discard f2's own change entirely, leaving this step's diff empty — git then refuses
      // `--continue` ("previous cherry-pick is now empty"), which is FR-118's empty-result path,
      // not the plain-Continue path this test exercises. A real resolution that keeps the
      // cherry-picked content is what a normal multi-commit Continue needs.
      await userEvent.click(await within(conflictView).findByRole("button", { name: /accept cherry-picking/i }));

      // Regression guard: `useCherryPickActions`/`useConflictResolution` route their mutating
      // calls through `graph.beginMutation()`'s self-write gate (specs/self-write-refresh-
      // suppression.md FR-6b) specifically so a real disk write mid-resolution can't be
      // misattributed to an external change. A fixed real-time wait (not a `waitFor` retry, which
      // would just return on its very first, still-clean check) gives a regression in that gate
      // its actual window to manifest before asserting its absence.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(
        operationStaleAlert(),
        "spurious 'changed outside GitHydra' alert appeared after GitHydra's own cherry-pick Accept click — see comment above",
      ).toBeNull();
      await waitForConflictResolutionSettled(conflictView);

      const continueButton = await screen.findByRole("button", { name: /^continue$/i });
      await waitFor(() => expect(continueButton).not.toBeDisabled());
      await userEvent.click(continueButton);

      await waitForOperationBannerGone();
      await waitFor(async () =>
        expect(await logSubjects(dir, 3)).toEqual(["f3: change c.txt", "f2: change b.txt", "f1: change a.txt"]),
      );
      expect(await hasCherryPickHead(dir)).toBe(false);
      // AC16: Changes badge cleared back to no-pending once the operation completed.
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: /changes, \d+ pending/i })).not.toBeInTheDocument(),
      );
      expect(externalBanner()).not.toBeInTheDocument();
      expect(operationStaleAlert()).not.toBeInTheDocument();
    },
    35000,
  );

  it(
    "AC6: clicking Abort at a paused step of a multi-commit sequence restores HEAD to the EXACT pre-sequence SHA, not merely undoing the current step",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "base-a\n");
      await writeFile(dir, "b.txt", "base-b\n");
      await writeFile(dir, "c.txt", "base-c\n");
      await commitAll(dir, "base");
      await git(dir, ["checkout", "-q", "-b", "feature"]);
      await commitFile(dir, "a.txt", "feature-a\n", "f1: change a.txt");
      await commitFile(dir, "b.txt", "feature-b\n", "f2: change b.txt");
      await commitFile(dir, "c.txt", "feature-c\n", "f3: change c.txt");
      await git(dir, ["checkout", "-q", "main"]);
      const preSequenceHead = await commitFile(dir, "b.txt", "main-b\n", "m1: change b.txt");

      await openAppOn(dir);
      await ctrlClickRow("f1: change a.txt");
      await ctrlClickRow("f2: change b.txt");
      await ctrlClickRow("f3: change c.txt");
      const menu = await rightClickRow("f3: change c.txt");
      await userEvent.click(within(menu).getByRole("menuitem", { name: /cherry-pick 3 commits/i }));

      // f1 is really committed before the abort — proves abort isn't merely a step-1 no-op.
      await waitFor(async () => expect(await headSha(dir)).not.toBe(preSequenceHead));
      await waitForOperationBannerText(/f2: change b\.txt/i);

      await userEvent.click(await screen.findByRole("button", { name: /^abort$/i }));
      const confirmDialog = await screen.findByRole("alertdialog");
      await userEvent.click(within(confirmDialog).getByRole("button", { name: /^abort$/i }));

      await waitForOperationBannerGone();
      expect(await headSha(dir)).toBe(preSequenceHead);
      const status = await git(dir, ["status", "--porcelain"]);
      expect(status.stdout.trim()).toBe("");
      expect(externalBanner()).not.toBeInTheDocument();
      expect(operationStaleAlert()).not.toBeInTheDocument();
    },
    30000,
  );

  it(
    "AC7: a commit already fully present on the branch pauses with the distinct empty-result notice (not ConflictResolutionView); Skip advances with no new commit",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "base\n", "base");
      await git(dir, ["checkout", "-q", "-b", "feature"]);
      await commitFile(dir, "a.txt", "feature change\n", "feature change");
      await git(dir, ["checkout", "-q", "main"]);
      // Pre-apply the SAME final content directly (different subject, so the graph never has two
      // rows sharing "feature change"'s text) so cherry-picking "feature change" is a genuine,
      // real empty result from the very first (single-commit) attempt.
      await commitFile(dir, "a.txt", "feature change\n", "pre-existing content");
      const beforeLog = await logSubjects(dir, 5);

      await openAppOn(dir);
      await cherryPickSingle("feature change");

      await waitForEmptyResultNoticeText(/already present/i);
      expect(screen.queryByRole("region", { name: /resolve conflict/i })).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /skip this commit/i }));
      await waitFor(() => expect(emptyResultNoticeText()).toBe(""));
      await waitFor(async () => expect(await logSubjects(dir, 5)).toEqual(beforeLog)); // no new commit.
      expect(await hasCherryPickHead(dir)).toBe(false);
    },
    30000,
  );

  it(
    "AC7: Commit-empty creates an empty commit carrying the original message verbatim",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "base\n", "base");
      await git(dir, ["checkout", "-q", "-b", "feature"]);
      await commitFile(dir, "a.txt", "feature change\n", "feature change\n\nWith a body line.");
      await git(dir, ["checkout", "-q", "main"]);
      await commitFile(dir, "a.txt", "feature change\n", "pre-existing content");

      await openAppOn(dir);
      await cherryPickSingle("feature change");
      await waitForEmptyResultNoticeText(/already present/i);

      const beforeCount = (await logSubjects(dir, 20)).length;
      await userEvent.click(screen.getByRole("button", { name: /commit anyway \(empty\)/i }));
      await waitFor(() => expect(emptyResultNoticeText()).toBe(""));

      await waitFor(async () => expect((await logSubjects(dir, 20)).length).toBe(beforeCount + 1));
      const newMessage = await git(dir, ["show", "-s", "--format=%B", "HEAD"]);
      expect(newMessage.stdout).toContain("feature change");
      expect(newMessage.stdout).toContain("With a body line.");
      const changedFiles = await git(dir, ["show", "--format=", "--name-only", "HEAD"]);
      expect(changedFiles.stdout.trim()).toBe(""); // genuinely empty commit.
    },
    30000,
  );

  it(
    "AC8: a 3-commit sequence with an empty-result step in the middle completes end-to-end via Skip, leaving 2 new commits",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "base-a\n");
      await writeFile(dir, "b.txt", "base-b\n");
      await writeFile(dir, "c.txt", "base-c\n");
      await commitAll(dir, "base");
      await git(dir, ["checkout", "-q", "-b", "feature"]);
      await commitFile(dir, "a.txt", "feature-a\n", "f1: change a.txt");
      await commitFile(dir, "b.txt", "feature-b\n", "f2: change b.txt");
      await commitFile(dir, "c.txt", "feature-c\n", "f3: change c.txt");
      await git(dir, ["checkout", "-q", "main"]);
      // b.txt already at f2's exact final content (different subject) — re-picking f2 later is a
      // genuine empty result, not a conflict.
      const preSequenceHead = await commitFile(dir, "b.txt", "feature-b\n", "m1: pre-apply b.txt");

      await openAppOn(dir);
      await ctrlClickRow("f1: change a.txt");
      await ctrlClickRow("f2: change b.txt");
      await ctrlClickRow("f3: change c.txt");
      const menu = await rightClickRow("f3: change c.txt");
      await userEvent.click(within(menu).getByRole("menuitem", { name: /cherry-pick 3 commits/i }));

      await waitForEmptyResultNoticeText(/f2: change b\.txt.*already present/i);
      await waitForOperationBannerText(/f2: change b\.txt.*1 more queued/i);

      await userEvent.click(screen.getByRole("button", { name: /skip this commit/i }));

      await waitForOperationBannerGone();
      const log = await git(dir, ["log", "--format=%s", `${preSequenceHead}..HEAD`]);
      expect(log.stdout.trim().split("\n")).toEqual(["f3: change c.txt", "f1: change a.txt"]); // f2 skipped.
      expect(await hasCherryPickHead(dir)).toBe(false);
    },
    30000,
  );

  it(
    "AC8: the same 3-commit sequence completes via Commit-empty instead, leaving 3 new commits",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "base-a\n");
      await writeFile(dir, "b.txt", "base-b\n");
      await writeFile(dir, "c.txt", "base-c\n");
      await commitAll(dir, "base");
      await git(dir, ["checkout", "-q", "-b", "feature"]);
      await commitFile(dir, "a.txt", "feature-a\n", "f1: change a.txt");
      await commitFile(dir, "b.txt", "feature-b\n", "f2: change b.txt");
      await commitFile(dir, "c.txt", "feature-c\n", "f3: change c.txt");
      await git(dir, ["checkout", "-q", "main"]);
      const preSequenceHead = await commitFile(dir, "b.txt", "feature-b\n", "m1: pre-apply b.txt");

      await openAppOn(dir);
      await ctrlClickRow("f1: change a.txt");
      await ctrlClickRow("f2: change b.txt");
      await ctrlClickRow("f3: change c.txt");
      const menu = await rightClickRow("f3: change c.txt");
      await userEvent.click(within(menu).getByRole("menuitem", { name: /cherry-pick 3 commits/i }));

      await waitForEmptyResultNoticeText(/f2: change b\.txt.*already present/i);
      await userEvent.click(screen.getByRole("button", { name: /commit anyway \(empty\)/i }));

      await waitForOperationBannerGone();
      const log = await git(dir, ["log", "--format=%s", `${preSequenceHead}..HEAD`]);
      expect(log.stdout.trim().split("\n")).toEqual(["f3: change c.txt", "f2: change b.txt", "f1: change a.txt"]);
      expect(await hasCherryPickHead(dir)).toBe(false);
    },
    30000,
  );

  it(
    "AC9: a merge commit is disabled with an explicit reason, alone or within a larger multi-selection — no git call is made regardless",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "base\n", "base");
      await git(dir, ["checkout", "-q", "-b", "other"]);
      await commitFile(dir, "other.txt", "other content\n", "other branch commit");
      await git(dir, ["checkout", "-q", "main"]);
      await git(dir, ["merge", "other", "--no-ff", "-m", "merge commit"]);

      await openAppOn(dir);

      let menu = await rightClickRow("merge commit");
      let item = within(menu).getByRole("menuitem", { name: /^cherry-pick$/i });
      expect(item).toBeDisabled();
      expect(item).toHaveAttribute("title", expect.stringMatching(/merge commit/i));

      const beforeHead = await headSha(dir);
      await ctrlClickRow("merge commit");
      await ctrlClickRow("other branch commit");
      menu = await rightClickRow("other branch commit");
      item = within(menu).getByRole("menuitem", { name: /cherry-pick 2 commits/i });
      expect(item).toBeDisabled();
      expect(item).toHaveAttribute("title", expect.stringMatching(/merge commit/i));

      expect(await headSha(dir)).toBe(beforeHead);
      expect(await hasCherryPickHead(dir)).toBe(false);
    },
    30000,
  );

  it(
    "AC10: on a bare repository, Cherry-pick is disabled with an explicit reason",
    async () => {
      const srcDir = await initRepo();
      dirs.push(srcDir);
      await commitFile(srcDir, "a.txt", "content\n", "initial commit");
      const bareDir = await makeTempDir();
      await cleanup(bareDir); // git clone --bare insists on creating its own target.
      await git(process.cwd(), ["clone", "--bare", "-q", srcDir, bareDir]);
      dirs.push(bareDir);

      await openAppOn(bareDir);
      await screen.findByText(/bare repository/i);

      const menu = await rightClickRow("initial commit");
      const item = within(menu).getByRole("menuitem", { name: /^cherry-pick$/i });
      expect(item).toBeDisabled();
      expect(item).toHaveAttribute("title", expect.stringMatching(/bare repository/i));
    },
    30000,
  );

  it(
    "AC10: on a repository whose checked-out branch has an unborn HEAD, there is no reachable path to Cherry-pick at all (the commit graph itself is replaced by the existing 'No commits yet' empty state, per commit-graph.md AC7 — even stronger than a merely-disabled control)",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await git(dir, ["checkout", "-q", "-b", "feature"]);
      await commitFile(dir, "a.txt", "content\n", "feature commit");
      await git(dir, ["checkout", "-q", "--orphan", "empty-branch"]);

      await openAppOn(dir);
      await screen.findByText(/no commits yet/i);
      // No commit graph/context menu surface exists in this state at all — the disabled-reason
      // mechanism itself (`computeCherryPickDisabledReason` correctly returning the "no commits
      // yet" message for `isUnbornHead`) is covered directly by
      // `packages/desktop/src/lib/cherryPickEligibility.test.ts`; this test confirms the real app
      // gives no path to reach it in the first place, which is what a user actually experiences.
      expect(screen.queryByRole("listbox", { name: /commit graph/i })).not.toBeInTheDocument();
    },
    30000,
  );

  it(
    "AC11: cherry-picking onto a detached HEAD succeeds and advances it directly, with no special gate",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      const baseSha = await commitFile(dir, "a.txt", "base\n", "base");
      await git(dir, ["checkout", "-q", "-b", "feature"]);
      await commitFile(dir, "a.txt", "feature change\n", "feature change");
      await git(dir, ["checkout", "-q", "--detach", baseSha]);
      expect(await isDetached(dir)).toBe(true);

      await openAppOn(dir);
      // Scoped to the StatusBanner's own exact copy — a per-row "HEAD (detached)" ref-chip label
      // also matches a bare /detached head/i, which would otherwise be ambiguous here.
      await screen.findByText(/detached head — not on a branch tip/i);
      await cherryPickSingle("feature change");

      await waitFor(async () => expect(await headSha(dir)).not.toBe(baseSha));
      expect(await isDetached(dir)).toBe(true); // still detached, no special dialog interrupted it.
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      const { stdout: content } = await git(dir, ["show", "HEAD:a.txt"]);
      expect(content).toBe("feature change\n");
    },
    30000,
  );

  it(
    "AC12: opening a repo where a multi-commit cherry-pick was already paused by a separate terminal shows the correct banner/remaining count, and Continue completes it correctly",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "base-a\n");
      await writeFile(dir, "b.txt", "base-b\n");
      await writeFile(dir, "c.txt", "base-c\n");
      await commitAll(dir, "base");
      await git(dir, ["checkout", "-q", "-b", "feature"]);
      await commitFile(dir, "a.txt", "feature-a\n", "f1: change a.txt");
      await commitFile(dir, "b.txt", "feature-b\n", "f2: change b.txt");
      await commitFile(dir, "c.txt", "feature-c\n", "f3: change c.txt");
      await git(dir, ["checkout", "-q", "main"]);
      await commitFile(dir, "b.txt", "main-b\n", "m1: change b.txt");
      const f1 = (await git(dir, ["rev-parse", "feature~2"])).stdout.trim();
      const f2 = (await git(dir, ["rev-parse", "feature~1"])).stdout.trim();
      const f3 = (await git(dir, ["rev-parse", "feature"])).stdout.trim();
      // Started entirely outside GitHydra, before it ever opened this repo.
      await git(dir, ["cherry-pick", f1, f2, f3]).catch(() => {});

      await openAppOn(dir);
      await waitForOperationBannerText(/f2: change b\.txt/i);
      expect(operationBannerText()).toMatch(/1 more queued/i);

      const changesPanel = await openChangesPanel();
      await userEvent.click(await within(changesPanel).findByText("b.txt"));
      const conflictView = await screen.findByRole("region", { name: /resolve conflict in b\.txt/i });
      // Accept theirs, not ours — see AC5/AC16's comment above for why: accepting ours here would
      // make this step's cherry-pick result empty, hitting FR-118's Skip/Commit-empty path instead
      // of the plain Continue flow this test exercises.
      await userEvent.click(await within(conflictView).findByRole("button", { name: /accept cherry-picking/i }));
      // Same self-write-gate regression guard as the AC5/AC16 test above — see its comment.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(operationStaleAlert()).toBeNull();
      await waitForConflictResolutionSettled(conflictView);
      const continueButton = await screen.findByRole("button", { name: /^continue$/i });
      await waitFor(() => expect(continueButton).not.toBeDisabled());
      await userEvent.click(continueButton);

      await waitForOperationBannerGone();
      expect(await hasCherryPickHead(dir)).toBe(false);
      await waitFor(async () =>
        expect(await logSubjects(dir, 3)).toEqual(["f3: change c.txt", "f2: change b.txt", "f1: change a.txt"]),
      );
    },
    30000,
  );

  it(
    "AC12: Abort also works correctly on a sequence GitHydra never initiated — restores the exact pre-sequence HEAD",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "base-a\n");
      await writeFile(dir, "b.txt", "base-b\n");
      await writeFile(dir, "c.txt", "base-c\n");
      await commitAll(dir, "base");
      await git(dir, ["checkout", "-q", "-b", "feature"]);
      await commitFile(dir, "a.txt", "feature-a\n", "f1: change a.txt");
      await commitFile(dir, "b.txt", "feature-b\n", "f2: change b.txt");
      await commitFile(dir, "c.txt", "feature-c\n", "f3: change c.txt");
      await git(dir, ["checkout", "-q", "main"]);
      const preSequenceHead = await commitFile(dir, "b.txt", "main-b\n", "m1: change b.txt");
      const f1 = (await git(dir, ["rev-parse", "feature~2"])).stdout.trim();
      const f2 = (await git(dir, ["rev-parse", "feature~1"])).stdout.trim();
      const f3 = (await git(dir, ["rev-parse", "feature"])).stdout.trim();
      await git(dir, ["cherry-pick", f1, f2, f3]).catch(() => {});

      await openAppOn(dir);
      await waitForOperationBannerText(/cherry-picking/i);
      await userEvent.click(await screen.findByRole("button", { name: /^abort$/i }));
      const confirmDialog = await screen.findByRole("alertdialog");
      await userEvent.click(within(confirmDialog).getByRole("button", { name: /^abort$/i }));

      await waitForOperationBannerGone();
      expect(await headSha(dir)).toBe(preSequenceHead);
    },
    30000,
  );

  it(
    "AC13: running `git cherry-pick --continue` from a separate terminal while idle on a paused sequence — documents the ACTUAL observed behavior against the literal acceptance criterion",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "base-a\n");
      await writeFile(dir, "b.txt", "base-b\n");
      await writeFile(dir, "c.txt", "base-c\n");
      await commitAll(dir, "base");
      await git(dir, ["checkout", "-q", "-b", "feature"]);
      await commitFile(dir, "a.txt", "feature-a\n", "f1: change a.txt");
      await commitFile(dir, "b.txt", "feature-b\n", "f2: change b.txt");
      await commitFile(dir, "c.txt", "feature-c\n", "f3: change c.txt");
      await git(dir, ["checkout", "-q", "main"]);
      await commitFile(dir, "b.txt", "main-b\n", "m1: change b.txt");

      await openAppOn(dir);
      await ctrlClickRow("f1: change a.txt");
      await ctrlClickRow("f2: change b.txt");
      await ctrlClickRow("f3: change c.txt");
      const menu = await rightClickRow("f3: change c.txt");
      await userEvent.click(within(menu).getByRole("menuitem", { name: /cherry-pick 3 commits/i }));
      await waitForOperationBannerText(/f2: change b\.txt/i);
      expect(operationBannerText()).toMatch(/1 more queued/i);

      // A SEPARATE terminal (not GitHydra's own IPC) resolves b.txt and continues — f3 applies
      // cleanly too, completing the whole sequence externally while GitHydra sits idle.
      await writeFile(dir, "b.txt", "resolved-b\n");
      await git(dir, ["add", "b.txt"]);
      await git(dir, ["cherry-pick", "--continue"], { GIT_EDITOR: "true" });
      expect(await hasCherryPickHead(dir)).toBe(false); // ground truth: really done on disk now.

      // Give the watcher's debounce window (150ms) plenty of margin to fire and be evaluated.
      await waitFor(
        () => {
          const staleAlert = operationStaleAlert();
          const bannerStillShowsOldState = operationBannerText().match(/f2: change b\.txt/i) !== null;
          // Documents observed behavior either way rather than assuming one outcome:
          expect(staleAlert !== null || !bannerStillShowsOldState).toBe(true);
        },
        { timeout: 5000 },
      );

      if (operationStaleAlert()) {
        // specs/graph-head-indicator-and-refresh-alerting.md Problem 2 (a LATER, more specific
        // policy than cherry-pick.md's own FR-59-inherited assumption): the banner's remaining-
        // queued count is NOT silently live-updated from an external operation-state change —
        // instead a distinct alert appears and the stale banner persists until Refresh is
        // clicked. See this test's accompanying report note.
        expect(operationBannerText()).toMatch(/f2: change b\.txt/i);
        expect(operationBannerText()).toMatch(/1 more queued/i);
        // Scoped to the operation-stale alert's own Refresh button — the Toolbar's unrelated
        // "Refresh commit graph" button also matches a bare /refresh/i.
        const alertBanner = screen.getByText(/changed outside gitHydra.*click refresh/i).closest('[role="alert"]')!;
        await userEvent.click(within(alertBanner as HTMLElement).getByRole("button", { name: /refresh/i }));
        await waitForOperationBannerGone();
      }
      await waitFor(async () =>
        expect(await logSubjects(dir, 3)).toEqual(["f3: change c.txt", "f2: change b.txt", "f1: change a.txt"]),
      );
    },
    30000,
  );

  it(
    "AC17: a plain click after a multi-selection clears it and opens that single commit's DetailPanel exactly as before this spec",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "v1\n", "commit one");
      await commitFile(dir, "a.txt", "v2\n", "commit two");
      await commitFile(dir, "a.txt", "v3\n", "commit three");

      await openAppOn(dir);
      await ctrlClickRow("commit one");
      await ctrlClickRow("commit two");
      expect(await rowFor("commit one")).toHaveAttribute("aria-selected", "true");
      expect(await rowFor("commit two")).toHaveAttribute("aria-selected", "true");

      await userEvent.click(await rowFor("commit three")); // plain click, no modifiers.

      expect(await rowFor("commit one")).toHaveAttribute("aria-selected", "false");
      expect(await rowFor("commit two")).toHaveAttribute("aria-selected", "false");
      const detailPanel = await screen.findByRole("complementary", { name: "Commit details" });
      await waitFor(() => expect(within(detailPanel).getByText("commit three")).toBeInTheDocument());
    },
    25000,
  );
});
