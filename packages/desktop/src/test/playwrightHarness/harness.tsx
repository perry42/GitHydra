/**
 * Test-only entry point for `harness.html` — see that file's doc comment for why this exists and
 * how it's served. Mounts the REAL `CommitGraph` production component (imported verbatim, never
 * reimplemented) against a large linear fixture history so a real browser has enough rows to
 * require scrolling past the first screenful — the exact condition under which the scroll-offset
 * regression this harness exists to catch (see CLAUDE.md "Known pitfalls") can reproduce.
 *
 * Deliberately a plain, single-purpose harness: no `window.gitHydra`, no IPC, no `<App/>` chrome
 * — `CommitGraph` only needs its own props (satisfied entirely from `src/test/fixtures.ts`, the
 * same fixture builders `GraphCanvas.test.tsx`/`CommitGraph.test.tsx` already use), so pulling in
 * the full app shell would only add irrelevant surface area to a test that's exclusively about
 * canvas/DOM pixel alignment.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { CommitGraph } from "../../components/CommitGraph/CommitGraph";
import { makeCommit, makeDisplayRows, makeRepoState } from "../fixtures";
import "../../theme.css";
import "../../global.css";

// Comfortably more than one screenful at ROW_HEIGHT=28px in any reasonable viewport — enough that
// scrolling partway through still leaves plenty of rows below for a real "scrolled past the first
// screenful" assertion.
const COMMIT_COUNT = 400;

function shaFor(index: number): string {
  // 40 hex-ish chars, unique per index — real commit shas are 40 chars, and several lower-level
  // helpers (LaneAssigner, ref-chip lookups) assume that shape.
  return `${index.toString(16).padStart(8, "0")}harness${"0".repeat(24)}`.slice(0, 40);
}

// A single unbroken lane (every commit's sole parent is the next-older commit, i.e. `git log
// --first-parent`-shaped) — deliberately the simplest possible topology. This harness exists to
// prove pixel *alignment* (canvas content vs. DOM rows), not lane-assignment correctness (already
// covered elsewhere, e.g. `laneAssignment.test.ts`), so every node lands at the same predictable
// lane (0) and x-coordinate.
const commits = Array.from({ length: COMMIT_COUNT }, (_, i) =>
  makeCommit(shaFor(i), i < COMMIT_COUNT - 1 ? [shaFor(i + 1)] : [], {
    subject: `Harness commit #${i}`,
  }),
);
const displayRows = makeDisplayRows(commits);
const repoState = makeRepoState({ headSha: commits[0]!.sha });

function Harness() {
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  return (
    // `.gh-commit-graph` (CommitGraph.css) is `flex: 1; min-height: 0`, sized by its flex parent
    // — mirrors the real app's layout (App.tsx's `.gh-app__body` flex row) closely enough for
    // `CommitGraph`'s own `ResizeObserver`-driven virtualization to behave identically to
    // production, without needing the rest of the app shell.
    <div style={{ display: "flex", height: "640px", width: "960px" }}>
      <CommitGraph
        displayRows={displayRows}
        maxLaneIndexSeen={0}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={() => {}}
        visibleRefNames={new Set()}
        repoState={repoState}
        selectedSha={selectedSha}
        onSelectCommit={setSelectedSha}
        onSelectCheckpoint={() => {}}
        theme="dark"
        onCheckoutCommit={() => {}}
        onCreateBranchAt={() => {}}
        onSwitchBranch={() => {}}
        onDeleteBranch={() => {}}
        onCherryPick={() => {}}
        cherryPickBusy={false}
      />
    </div>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("Root element #root not found");

createRoot(container).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
