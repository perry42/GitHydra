// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRecoveryRestore, type UseRecoveryRestoreOptions } from "./useRecoveryRestore";
import { createDirtyLeaveRegistry, type DirtyLeaveRegistry } from "./useDirtyLeaveGuard";
import { RecoveryRestoreDialog } from "../components/RecoveryRestoreDialog/RecoveryRestoreDialog";
import { makeMockGitHydra } from "../test/mockGitHydra";
import type { GitHydraApi, RecoveryDraft } from "../../shared/ipcContract";

type RecoveryDraftDialogHarnessProps = UseRecoveryRestoreOptions;

/** The hook plus its dialog, and a stand-in for the palette entry. */
function Harness(props: RecoveryDraftDialogHarnessProps) {
  const r = useRecoveryRestore(props);
  return (
    <div>
      <span data-testid="has-drafts">{r.hasDrafts ? "yes" : "no"}</span>
      <button type="button" onClick={r.restoreNow}>
        palette: restore
      </button>
      {r.offer && <RecoveryRestoreDialog offer={r.offer} onChoose={r.answer} />}
    </div>
  );
}

const H = (c: string) => c.repeat(64);
const REPO = "/repo";
const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const draft = (relativePath: string, over: Partial<RecoveryDraft> = {}): RecoveryDraft => ({
  relativePath,
  content: "draft text\r\n",
  bom: true,
  eol: "crlf",
  finalNewline: true,
  expectedHash: H("a"),
  savedAt: 1_700_000_000_000,
  ...over,
});
const eligible = { eligible: true as const, hasStagedContent: false, isNew: false, isUntracked: false, size: 3, mtimeMs: 1, mode: 0o644 };

function apiWith(drafts: RecoveryDraft[], diskHash: Record<string, string> = {}, probe: Record<string, unknown> = {}): GitHydraApi {
  const api = makeMockGitHydra();
  // listDrafts is newest first, so the test order is the display order.
  api.listDrafts = vi.fn(() =>
    Promise.resolve({ ok: true as const, data: drafts.map((d) => ({ relativePath: d.relativePath, savedAt: d.savedAt, size: d.content.length })) }),
  ) as GitHydraApi["listDrafts"];
  api.readDraft = vi.fn((_r: string, p: string) => Promise.resolve({ ok: true as const, data: drafts.find((d) => d.relativePath === p) ?? null })) as GitHydraApi["readDraft"];
  api.probeEditableFile = vi.fn((p: string) => Promise.resolve({ ok: true as const, data: (probe[p] ?? eligible) as never })) as GitHydraApi["probeEditableFile"];
  api.readEditableFile = vi.fn((p: string) =>
    Promise.resolve({
      ok: true as const,
      data: { ...eligible, content: "disk\n", eol: "lf" as const, hasBom: false, finalNewline: true, contentHash: diskHash[p] ?? H("a") },
    }),
  ) as GitHydraApi["readEditableFile"];
  return api;
}

function mount(api: GitHydraApi, props: Partial<RecoveryDraftDialogHarnessProps> = {}) {
  const guard: DirtyLeaveRegistry = props.dirtyGuard ?? createDirtyLeaveRegistry();
  const onRestore = vi.fn();
  const base: RecoveryDraftDialogHarnessProps = { api, repoPath: REPO, ready: true, openSequence: 1, modalOpen: false, dirtyGuard: guard, onRestore, ...props };
  const utils = render(<Harness {...base} />);
  const rerender = (next: Partial<RecoveryDraftDialogHarnessProps>) => utils.rerender(<Harness {...base} {...next} />);
  return { ...utils, api, guard, onRestore, rerender };
}

const dlg = () => screen.findByRole("alertdialog");

describe("restore offer chain (specs/edit-recovery-draft.md FR-549..552)", () => {
  it("asks 'Restore your unsaved edits to <file>?' with Restore focused and Discard never focused; the name labels the dialog", async () => {
    mount(apiWith([draft("src/a.ts")]));
    const d = await dlg();
    expect(d).toHaveAccessibleName("Restore your unsaved edits to a.ts?");
    expect(within(d).getByRole("button", { name: "Restore" })).toHaveFocus();
    expect(within(d).getByRole("button", { name: "Discard" })).not.toHaveFocus();
    expect(within(d).getByRole("button", { name: "Discard" })).toHaveClass("gh-confirm-dialog__secondary--destructive");
    expect(within(d).queryByText(/changed on disk since your draft/)).toBeNull();
  });

  it("a changed file adds the exact FR-551 warning", async () => {
    mount(apiWith([draft("src/a.ts")], { "src/a.ts": H("z") }));
    const d = await dlg();
    expect(within(d).getByText("This file changed on disk since your draft was saved. Restoring keeps your draft in the editor. Saving will ask before overwriting.")).toBeInTheDocument();
  });

  it("drafts are offered newest first one at a time; Discard moves to the next; Restore hands the draft over and ends the chain", async () => {
    const api = apiWith([draft("src/new.ts", { savedAt: 3000 }), draft("src/mid.ts", { savedAt: 2000 }), draft("src/old.ts", { savedAt: 1000 })]);
    const { onRestore } = mount(api);
    let d = await dlg();
    expect(d).toHaveAccessibleName("Restore your unsaved edits to new.ts?");
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    fireEvent.click(within(d).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toHaveAccessibleName("Restore your unsaved edits to mid.ts?"));
    expect(api.deleteDraft).toHaveBeenCalledWith(REPO, "src/new.ts");
    d = screen.getByRole("alertdialog");
    fireEvent.click(within(d).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith({ path: "src/mid.ts", draft: expect.objectContaining({ expectedHash: H("a") }) }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await new Promise((r) => setTimeout(r, 40));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.readDraft).not.toHaveBeenCalledWith(REPO, "src/old.ts");
    // The rest stay available through the palette entry.
    fireEvent.click(screen.getByRole("button", { name: "palette: restore" }));
    expect(await dlg()).toHaveAccessibleName("Restore your unsaved edits to new.ts?");
  });

  it("strips bidi control characters from the file name shown", async () => {
    mount(apiWith([draft("src/a‮b.ts")]));
    expect(await dlg()).toHaveAccessibleName("Restore your unsaved edits to ab.ts?");
  });

  it("Not now (and Esc) keeps the draft and stops the chain; the palette re-runs it", async () => {
    const api = apiWith([draft("src/new.ts", { savedAt: 2000 }), draft("src/old.ts", { savedAt: 1000 })]);
    const { onRestore } = mount(api);
    const d = await dlg();
    fireEvent.keyDown(d, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.deleteDraft).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
    expect(api.readDraft).not.toHaveBeenCalledWith(REPO, "src/old.ts");

    fireEvent.click(screen.getByRole("button", { name: "palette: restore" }));
    expect(await dlg()).toHaveAccessibleName("Restore your unsaved edits to new.ts?");
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("a draft whose file is gone is deleted silently; one that is ineligible for another reason is kept without a prompt", async () => {
    const api = apiWith(
      [draft("src/gone.ts", { savedAt: 3000 }), draft("src/bin.png", { savedAt: 2000 }), draft("src/ok.ts", { savedAt: 1000 })],
      {},
      {
        "src/gone.ts": { eligible: false, reason: "deleted", message: "The file does not exist in the working tree" },
        "src/bin.png": { eligible: false, reason: "binary", message: "Binary file" },
      },
    );
    mount(api);
    expect(await dlg()).toHaveAccessibleName("Restore your unsaved edits to ok.ts?");
    expect(api.deleteDraft).toHaveBeenCalledTimes(1);
    expect(api.deleteDraft).toHaveBeenCalledWith(REPO, "src/gone.ts");
  });

  it("waits while another modal is open or an editor buffer is dirty, then prompts", async () => {
    const api = apiWith([draft("src/a.ts")]);
    const guard = createDirtyLeaveRegistry();
    let dirty = true;
    guard.register({ isDirty: () => dirty, requestLeave: () => Promise.resolve(true) });
    const { rerender } = mount(api, { modalOpen: true, dirtyGuard: guard });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.probeEditableFile).not.toHaveBeenCalled();
    rerender({ modalOpen: false, dirtyGuard: guard });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    dirty = false;
    act(() => guard.notify());
    expect(await dlg()).toBeInTheDocument();
  });

  it("does nothing until the repo is ready, and starts over for another repo", async () => {
    const api = apiWith([draft("src/a.ts")]);
    const { rerender } = mount(api, { ready: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(api.listDrafts).not.toHaveBeenCalled();
    rerender({ ready: true });
    await dlg();
    expect(api.listDrafts).toHaveBeenCalledWith(REPO);
    rerender({ ready: true, repoPath: "/other", openSequence: 2 });
    await waitFor(() => expect(api.listDrafts).toHaveBeenCalledWith("/other"));
  });

  it("reports whether the repo has drafts for the palette entry", async () => {
    mount(apiWith([]));
    await waitFor(() => expect(screen.getByTestId("has-drafts")).toHaveTextContent("no"));
    mount(apiWith([draft("src/a.ts")]));
    await waitFor(() => expect(screen.getAllByTestId("has-drafts").at(-1)).toHaveTextContent("yes"));
  });

  it("a failed or throwing IPC just means no prompt", async () => {
    const api = apiWith([draft("src/a.ts")]);
    mock(api.listDrafts).mockRejectedValueOnce(new Error("x"));
    mount(api);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
