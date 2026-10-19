// SPDX-License-Identifier: GPL-3.0-or-later
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorktreeEntry } from "@githydra/git-core";
import { copyIntoNotice } from "../../lib/worktreeCopyExisting";
import type { WorktreeNotice } from "../../lib/worktreeNotices";
import { indexWorktrees } from "../../lib/worktrees";
import { useBranchActions } from "../../hooks/useBranchActions";
import { makeLocalBranch, makeRepoState } from "../../test/fixtures";
import { makeMockGitHydra, mockWorktreeEntry } from "../../test/mockGitHydra";
import { BranchesPanel } from "../BranchesPanel/BranchesPanel";
import { WorktreeNotices } from "../WorktreeNotices/WorktreeNotices";

function notice(result: Parameters<typeof copyIntoNotice>[0], id = 1): WorktreeNotice {
  const m = copyIntoNotice(result);
  return { id, tone: m.tone, text: m.text, parts: m.parts, actions: [] };
}

const partial = notice({
  status: "done",
  copied: 2,
  bytes: 4096,
  skipped: [{ path: "config/local.json", reason: "already-exists", text: "already exists" }],
  skippedTotal: 1,
  from: "acme",
  into: "tour-login",
});

describe("copy result banner (FR-655, AC 19)", () => {
  it("renders the sentence with file names in <code>, ONE quiet Dismiss, the shared banner classes and no side stripe", async () => {
    const onDismiss = vi.fn();
    render(<WorktreeNotices notices={[partial]} onDismiss={onDismiss} onOpenBranches={vi.fn()} />);
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("Copied 2 files (4 KB) from acme into tour-login. Not copied: config/local.json (already exists).");
    expect(within(banner).getByText("config/local.json").tagName).toBe("CODE");
    expect(banner).toHaveClass("gh-status-banner", "gh-status-banner--warning");
    const buttons = within(banner).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Dismiss"]);
    expect(buttons[0]).toHaveClass("gh-status-banner__action--quiet");
    expect(banner.getAttribute("style")).toBeNull();
    expect(banner.textContent).not.toMatch(/remember/i);
    await userEvent.click(buttons[0]!);
    expect(onDismiss).toHaveBeenCalledWith(1);
  });

  it("success is a status banner; a copy with skips is an alert; the tone follows the table", () => {
    const ok = notice({ status: "done", copied: 3, bytes: 4096, skipped: [], skippedTotal: 0, from: "acme", into: "tour-login" }, 2);
    render(<WorktreeNotices notices={[ok, partial]} onDismiss={vi.fn()} onOpenBranches={vi.fn()} />);
    const status = screen.getByRole("status");
    expect(status).toHaveClass("gh-status-banner--success");
    expect(status).toHaveTextContent("Copied 3 files (4 KB) from acme into tour-login.");
  });

  it("a sentinel in a skipped entry's code or in a thrown error never reaches the DOM", () => {
    const n = notice({
      status: "done",
      copied: 1,
      bytes: 1,
      skipped: [{ path: "a.txt", reason: "SENTINEL-EACCES", text: "could not be read" }],
      skippedTotal: 1,
      from: "acme",
      into: "tour-login",
    });
    const { container } = render(<WorktreeNotices notices={[n]} onDismiss={vi.fn()} onOpenBranches={vi.fn()} />);
    expect(container.textContent).toContain("a.txt");
    expect(container.textContent).toContain("(could not be read)");
    expect(container.textContent).not.toContain("SENTINEL");
  });
});

function Harness({ notices, collapsed }: { notices: WorktreeNotice[]; collapsed: boolean }) {
  const api = makeMockGitHydra({ localBranches: [makeLocalBranch("main", { isCurrent: true })] });
  const actions = useBranchActions({ api, onChanged: () => {} });
  const entries: WorktreeEntry[] = [mockWorktreeEntry({ id: null, isMain: true, path: "/w/acme", branch: "main" }), mockWorktreeEntry({ id: "tl", path: "/w/t", branch: "t" })];
  window.localStorage.setItem("githydra:layout:worktreesCollapsed", collapsed ? "1" : "0");
  return (
    <BranchesPanel
      api={api}
      repoState={makeRepoState()}
      actions={actions}
      onRequestNewBranch={() => {}}
      collapsed={false}
      onToggleCollapsed={() => {}}
      onLocateBranch={() => {}}
      lastFetchedAt={null}
      worktrees={{
        state: {
          status: "ready",
          list: { entries, untrusted: false, untrustedReason: null, commonDir: "/w/acme/.git", mainPath: "/w/acme", format: "nul", mainPathIsGitDir: false },
          errorMessage: null,
          index: indexWorktrees(entries),
          reload: () => {},
        },
        isOpenAsTab: () => false,
        notices,
        onDismissNotice: vi.fn(),
        onOpenBranches: vi.fn(),
        onOpen: vi.fn(),
        onRemove: vi.fn(),
        onCleanUp: vi.fn(),
        onCreateNew: vi.fn(),
        onCreateForBranch: vi.fn(),
        onCreateForRemote: vi.fn(),
        headingRef: createRef<HTMLHeadingElement>(),
        onMenuOpenChange: vi.fn(),
      }}
    />
  );
}

describe("banner host (FR-634 via FR-655)", () => {
  it.each([false, true])("sits above the Worktrees list in the Branches panel (list collapsed: %s)", async (collapsed) => {
    render(<Harness notices={[partial]} collapsed={collapsed} />);
    const region = await screen.findByRole("region", { name: "Worktree notices" });
    const heading = screen.getByRole("heading", { name: /Worktrees/ });
    expect(region.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(region.closest(".gh-branches-panel")).not.toBeNull();
  });
});
