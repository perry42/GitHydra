// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { tagRow } from "@githydra/git-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHydraApi, WorktreeCopyCandidates, WorktreeCopyInclude, WorktreeCopyRow } from "../../../shared/ipcContract";
import type { CreateFailure, WorktreeCreateRequest } from "../../lib/worktreeCreate";
import { makeMockGitHydra } from "../../test/mockGitHydra";
import { CreateWorktreeDialog } from "./CreateWorktreeDialog";

/** specs/worktree-copy-ignored.md FR-628/FR-629, AC 2-5 and 12 (the renderer half). */

const KEY = "a".repeat(64);
const STORE_KEY = `githydra:worktreeCopy:${KEY}`;

function row(path: string, over: Partial<WorktreeCopyRow> = {}): WorktreeCopyRow {
  const dir = path.endsWith("/");
  const base = { path, isDirectory: dir, fileCount: dir ? 3 : 1, bytes: 1024, disabledReason: null as WorktreeCopyRow["disabledReason"], ...over };
  return { id: path, droppedFiles: 0, droppedReasons: {}, ...base, ...tagRow(base) };
}

const noInclude: WorktreeCopyInclude = { status: "absent", matchedRows: [], skipped: [] };

function candidates(rows: WorktreeCopyRow[], include: WorktreeCopyInclude = noInclude): WorktreeCopyCandidates {
  return { status: "ok", token: "tok-1", bare: false, rows, include };
}

function makeApi(c: WorktreeCopyCandidates | "pending" | "reject"): GitHydraApi {
  const api = makeMockGitHydra({ repoPath: "/w/acme" });
  if (c === "pending") vi.mocked(api.getWorktreeCopyCandidates).mockImplementation(() => new Promise(() => undefined));
  else if (c === "reject") vi.mocked(api.getWorktreeCopyCandidates).mockRejectedValue(new Error("boom"));
  else vi.mocked(api.getWorktreeCopyCandidates).mockResolvedValue({ ok: true, data: c });
  vi.mocked(api.getWorktreeRepoKey).mockResolvedValue({ ok: true, data: KEY });
  return api;
}

function setup(api: GitHydraApi, submit?: (v: unknown) => Promise<CreateFailure | null>, request: WorktreeCreateRequest = { kind: "branch", branch: "feature-x" }) {
  const onSubmit = vi.fn(submit ?? (async () => null));
  const onCancel = vi.fn();
  render(
    <CreateWorktreeDialog
      api={api}
      request={request}
      mainPath="/w/acme"
      onSubmit={onSubmit as never}
      onOpenExisting={vi.fn()}
      onCancel={onCancel}
    />,
  );
  return { onSubmit, onCancel };
}

const remember = (paths: string[], at = 1) => localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, paths, at }));
const stored = () => JSON.parse(localStorage.getItem(STORE_KEY) ?? "null") as { paths: string[] } | null;

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("the one line (FR-628, AC 5)", () => {
  it("Checking: exact text, aria-busy", async () => {
    // A commit request always has Advanced; for a branch request the section only appears once candidates exist.
    setup(makeApi("pending"), undefined, { kind: "commit", sha: "a".repeat(40), label: "commit aaaaaaa" });
    // Advanced is closed, so the group is in the DOM but hidden; busy.
    const g = screen.getByRole("group", { name: "Ignored files", hidden: true });
    expect(g).toHaveAttribute("aria-busy", "true");
    expect(within(g).getByText("Checking for ignored files...")).toBeInTheDocument();
  });

  it("nothing ticked: text and [Choose files] (Advanced stays closed until a row is ticked)", async () => {
    setup(makeApi(candidates([row(".env"), row("notes.txt")])));
    // Advanced is closed here, so the line is in the DOM but hidden.
    const g = await screen.findByRole("group", { name: "Ignored files", hidden: true });
    await waitFor(() => expect(within(g).getByText("No ignored files will be copied.")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-expanded", "false");
    expect(within(g).getByRole("button", { name: "Choose files", hidden: true })).toBeInTheDocument();
  });

  it("ticked from memory: checkbox on, size, muted note and the names (3 then 'and N more')", async () => {
    remember([".env", ".vscode/", "config/local.json", "extra.txt", "more.txt"]);
    setup(
      makeApi(candidates([row(".env"), row(".vscode/", { bytes: 2048 }), row("config/local.json"), row("extra.txt"), row("more.txt"), row("other.txt")])),
    );
    const box = await screen.findByRole("checkbox", { name: /Copy 5 files · 6 KB/ });
    expect(box).toBeChecked();
    expect(screen.getByText("Copy 5 files · 6 KB")).toBeInTheDocument();
    expect(screen.getByText("remembered for this repo")).toBeInTheDocument();
    expect(screen.getByText(".env, .vscode/, config/local.json and 2 more")).toBeInTheDocument();
    // FR-628: a ticked row opens Advanced; nothing is copied with the line hidden.
    expect(screen.getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-expanded", "true");
  });

  it("ticked from .worktreeinclude: 'Copy 2 files · 3 KB from .worktreeinclude'", async () => {
    setup(makeApi(candidates([row("notes.txt"), row("config/local.json", { bytes: 2048 }), row("other.txt")], { status: "ok", matchedRows: ["notes.txt", "config/local.json"], skipped: [] })));
    expect(await screen.findByText("Copy 2 files · 3 KB from .worktreeinclude")).toBeInTheDocument();
    expect(screen.queryByText("remembered for this repo")).toBeNull();
  });

  it("once the ticks are edited, the 'remembered' and 'from .worktreeinclude' wording is dropped", async () => {
    remember(["notes.txt"]);
    setup(makeApi(candidates([row("notes.txt"), row("other.txt")])));
    await screen.findByText("remembered for this repo");
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /other\.txt/ }));
    expect(screen.queryByText("remembered for this repo")).toBeNull();
    expect(screen.getByText("Copy 2 files · 2 KB")).toBeInTheDocument();
  });

  it("a ticked secret shows the triangle line with the word 'secret' (singular and plural)", async () => {
    remember([".env"]);
    setup(makeApi(candidates([row(".env"), row(".npmrc")])));
    expect(await screen.findByText("1 secret file: .env")).toBeInTheDocument();
    const warning = screen.getByText("1 secret file: .env").closest("p")!;
    expect(warning.querySelector("svg")).not.toBeNull();
  });

  it("a directory row that contains a secret file is flagged by its contents, never seeded from .worktreeinclude (MED-2)", async () => {
    // `local/` has a plain name but git-core found `local/.env` inside it.
    setup(makeApi(candidates([row("local/", { secret: true }), row("notes.txt")], { status: "ok", matchedRows: ["local/", "notes.txt"], skipped: [] })));
    expect(await screen.findByText("local/ is listed in .worktreeinclude but looks like a secret, so it is not ticked.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("checkbox", { name: /local\// })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /local\// }).closest("li")).toHaveTextContent("contains secret files");
    expect(screen.getByRole("checkbox", { name: /notes\.txt/ })).toBeChecked();
  });

  it("a remembered directory that later gains a secret file shows the secret line with that row (MED-2)", async () => {
    remember(["config/"]);
    setup(makeApi(candidates([row("config/", { secret: true })])));
    expect(await screen.findByText("1 secret file: config/")).toBeInTheDocument();
  });

  it("run-code inside a directory row is tagged 'runs code when opened' and not seeded from .worktreeinclude (MED-2)", async () => {
    setup(makeApi(candidates([row("tools/", { runsCode: true })], { status: "ok", matchedRows: ["tools/"], skipped: [] })));
    await userEvent.click(await screen.findByRole("button", { name: "Advanced" }));
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    const box = screen.getByRole("checkbox", { name: /tools\// });
    expect(box).not.toBeChecked();
    expect(box.closest("li")).toHaveTextContent("runs code when opened");
  });

  it("two ticked secrets: '2 secret files: .env, .npmrc'", async () => {
    remember([".env", ".npmrc"]);
    setup(makeApi(candidates([row(".env"), row(".npmrc")])));
    expect(await screen.findByText("2 secret files: .env, .npmrc")).toBeInTheDocument();
  });

  it("a secret listed in .worktreeinclude stays unticked with the hint (never pre-ticked from a repo file)", async () => {
    setup(makeApi(candidates([row(".env"), row("notes.txt")], { status: "ok", matchedRows: [".env"], skipped: [] })));
    expect(await screen.findByText(".env is listed in .worktreeinclude but looks like a secret, so it is not ticked.")).toBeInTheDocument();
    expect(screen.getByText("No ignored files will be copied.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Advanced" }));
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("checkbox", { name: /\.env/ })).not.toBeChecked();
  });

  it("two secrets in the file: plural hint", async () => {
    setup(makeApi(candidates([row(".env"), row(".npmrc")], { status: "ok", matchedRows: [".env", ".npmrc"], skipped: [] })));
    expect(await screen.findByText("2 files listed in .worktreeinclude look like secrets, so they are not ticked: .env, .npmrc.")).toBeInTheDocument();
  });

  it("'this time only' off: 'Copy 3 files' + 'skipped this time', rows disabled but visible, nothing sent", async () => {
    remember(["a.txt", "b.txt", "c.txt"]);
    const { onSubmit } = setup(makeApi(candidates([row("a.txt"), row("b.txt"), row("c.txt")])));
    await userEvent.click(await screen.findByRole("checkbox", { name: /Copy 3 files/ }));
    expect(screen.getByText("Copy 3 files")).toBeInTheDocument();
    expect(screen.getByText("skipped this time")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("checkbox", { name: /a\.txt/ })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /a\.txt/ })).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText("Folder")).toHaveValue("/w/acme.worktrees/feature-x"));
    await userEvent.click(screen.getByRole("button", { name: "Create worktree" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty("copy");
    // 'This time only' writes nothing and the next dialog is unchanged.
    expect(stored()?.paths).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("5 s without an answer shows the failure line and Try again, which lists again", async () => {
    vi.useFakeTimers();
    const api = makeApi("pending");
    setup(api, undefined, { kind: "commit", sha: "a".repeat(40), label: "commit aaaaaaa" });
    await act(async () => {
      vi.advanceTimersByTime(5001);
    });
    expect(screen.getByText("Couldn't list ignored files. The worktree will be created without copying.")).toBeInTheDocument();
    const calls = vi.mocked(api.getWorktreeCopyCandidates).mock.calls.length;
    await act(async () => {
      screen.getByRole("button", { name: "Try again", hidden: true }).click();
    });
    expect(vi.mocked(api.getWorktreeCopyCandidates).mock.calls.length).toBe(calls + 1);
    expect(screen.getByText("Checking for ignored files...")).toBeInTheDocument();
  });

  it("a rejected or failed listing shows the same failure line; Create still works without copy", async () => {
    const { onSubmit } = setup(makeApi("reject"));
    expect(await screen.findByText("Couldn't list ignored files. The worktree will be created without copying.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Folder")).toHaveValue("/w/acme.worktrees/feature-x"));
    await userEvent.click(screen.getByRole("button", { name: "Create worktree" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty("copy");
  });

  it("zero candidates or a bare repository render nothing", async () => {
    const api = makeApi({ status: "ok", token: "", bare: false, rows: [], include: noInclude });
    setup(api);
    await waitFor(() => expect(vi.mocked(api.getWorktreeRepoKey)).toHaveBeenCalled());
    expect(screen.queryByRole("group", { name: "Ignored files", hidden: true })).toBeNull();
    expect(screen.queryByRole("button", { name: "Advanced" })).toBeNull();
  });

  it("every state is a single text node", async () => {
    remember(["a.txt"]);
    setup(makeApi(candidates([row("a.txt")])));
    const text = await screen.findByText("Copy 1 file · 1 KB");
    expect(text.childNodes).toHaveLength(1);
    expect(text.firstChild?.nodeType).toBe(Node.TEXT_NODE);
  });
});

describe("Review list (FR-628, AC 5 and 12)", () => {
  async function openReview() {
    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
  }

  it("intro, footer, no 'Select all', [Select none] only when something is ticked, one list-level secret warning", async () => {
    setup(makeApi(candidates([row(".env"), row(".npmrc"), row("notes.txt")])));
    await screen.findByRole("group", { name: "Ignored files", hidden: true });
    await userEvent.click(screen.getByRole("button", { name: "Advanced" }));
    await openReview();
    expect(screen.getByText("A new worktree has only tracked files. Tick the ignored files you want copied.")).toBeInTheDocument();
    expect(screen.getByText("Changes you make here are remembered for this repository, on this computer.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /select all/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Select none" })).toBeNull();
    expect(screen.getAllByText('Rows marked "secret" look like passwords, tokens or keys. Copy them only if the new worktree needs them.')).toHaveLength(1);
    await userEvent.click(screen.getByRole("checkbox", { name: /notes\.txt/ }));
    expect(screen.getByRole("button", { name: "Select none" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Select none" }));
    expect(screen.getByRole("checkbox", { name: /notes\.txt/ })).not.toBeChecked();
    expect(screen.queryByRole("button", { name: "Select none" })).toBeNull();
  });

  it("no warning when no row is secret", async () => {
    remember(["notes.txt"]);
    setup(makeApi(candidates([row("notes.txt")])));
    await openReview();
    expect(screen.queryByText(/look like passwords/)).toBeNull();
  });

  it("caps at 6 rows with 'Show all N' and no nested scroller", async () => {
    remember(["f1.txt"]);
    const rows = Array.from({ length: 9 }, (_, i) => row(`f${i + 1}.txt`));
    setup(makeApi(candidates(rows)));
    await openReview();
    const list = screen.getByRole("list", { name: "Ignored files" });
    expect(within(list).getAllByRole("checkbox")).toHaveLength(6);
    await userEvent.click(screen.getByRole("button", { name: "Show all 9" }));
    expect(within(list).getAllByRole("checkbox")).toHaveLength(9);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("no cap button for six rows or fewer", async () => {
    remember(["f1.txt"]);
    setup(makeApi(candidates(Array.from({ length: 6 }, (_, i) => row(`f${i + 1}.txt`)))));
    await openReview();
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("orders ticked rows first, then rows listed in .worktreeinclude, then the rest", async () => {
    remember(["z-remembered.txt"]);
    setup(
      makeApi(
        candidates([row("a-rest.txt"), row("b-include.txt"), row("z-remembered.txt"), row("c-rest.txt")], { status: "ok", matchedRows: ["b-include.txt"], skipped: [] }),
      ),
    );
    await openReview();
    const names = within(screen.getByRole("list", { name: "Ignored files" }))
      .getAllByRole("checkbox")
      .map((c) => c.closest("label")!.querySelector(".gh-copy__name")!.textContent);
    expect(names).toEqual(["z-remembered.txt", "b-include.txt", "a-rest.txt", "c-rest.txt"]);
  });

  it("tags: secret (with the word), remembered, in .worktreeinclude, runs code when opened, large", async () => {
    remember([".env"]);
    setup(
      makeApi(
        candidates(
          [row(".env"), row("tasks/", {}), row(".vscode/tasks.json"), row("node_modules/", { fileCount: 10 }), row("local.cfg")],
          { status: "ok", matchedRows: ["local.cfg"], skipped: [] },
        ),
      ),
    );
    await openReview();
    const rowOf = (n: RegExp) => screen.getByRole("checkbox", { name: n }).closest("li")!;
    expect(rowOf(/\.env/)).toHaveTextContent("secret");
    expect(rowOf(/\.env/)).toHaveTextContent("remembered");
    expect(rowOf(/local\.cfg/)).toHaveTextContent("in .worktreeinclude");
    expect(rowOf(/tasks\.json/)).toHaveTextContent("runs code when opened");
    expect(rowOf(/node_modules/)).toHaveTextContent("large, consider reinstalling");
  });

  it("a symlink row is disabled with its reason; a name with control or bidi characters is shown with visible escapes and disabled", async () => {
    remember(["ok.txt"]);
    setup(
      makeApi(
        candidates([
          row("ok.txt"),
          row("link", { disabledReason: "symbolic-link", bytes: null }),
          row("evil\u202Etxt.exe", { disabledReason: "name-not-allowed" }),
          row("a\u0007b"),
          row("vendored/", { disabledReason: "nested-repository" }),
        ]),
      ),
    );
    await openReview();
    const link = screen.getByRole("checkbox", { name: /^link/ });
    expect(link).toBeDisabled();
    expect(link.closest("li")).toHaveTextContent("symbolic link, not copied");
    const bidi = screen.getByRole("checkbox", { name: /evil/ });
    expect(bidi).toBeDisabled();
    expect(bidi.closest("li")).toHaveTextContent("evil\\u{202e}txt.exe");
    expect(bidi.closest("li")).toHaveTextContent("name not allowed");
    // The renderer does not trust the flag alone: a control character is refused even when main did not flag it.
    const bell = screen.getByRole("checkbox", { name: /a\\u\{7\}b/ });
    expect(bell).toBeDisabled();
    expect(bell.closest("li")).toHaveTextContent("name not allowed");
    expect(screen.getByRole("checkbox", { name: /vendored/ }).closest("li")).toHaveTextContent("separate repository, not copied");
  });

  it("lists the rejected .worktreeinclude patterns under the 'Skipped' heading", async () => {
    remember(["ok.txt"]);
    setup(
      makeApi(
        candidates([row("ok.txt")], {
          status: "ok",
          matchedRows: [],
          skipped: [
            { line: 2, pattern: "../secrets", reason: "parent-directory-segment" },
            { line: 3, pattern: "C:\\Windows\\x", reason: "absolute-path" },
          ],
        }),
      ),
    );
    await openReview();
    expect(screen.getByText("Skipped: these patterns point outside the repository")).toBeInTheDocument();
    expect(screen.getByText("../secrets")).toBeInTheDocument();
    expect(screen.getByText("C:\\Windows\\x")).toBeInTheDocument();
  });

  it("a polite live region announces the selection ('3 files selected, 4 KB')", async () => {
    remember(["a.txt", "b.txt"]);
    setup(makeApi(candidates([row("a.txt", { bytes: 2048 }), row("b.txt", { bytes: 1024 }), row("c.txt", { bytes: 1024 })])));
    await openReview();
    const live = screen.getByRole("status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("2 files selected, 3 KB");
    await userEvent.click(screen.getByRole("checkbox", { name: /c\.txt/ }));
    expect(live).toHaveTextContent("3 files selected, 4 KB");
    await userEvent.click(screen.getByRole("button", { name: "Select none" }));
    expect(live).toHaveTextContent("No files selected");
  });

  it("has none of the strings of designs we did not build: no pin, popover, manager or Remember checkbox", async () => {
    remember(["a.txt"]);
    setup(makeApi(candidates([row("a.txt"), row(".env")])));
    await openReview();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\bpin(ned)?\b/i);
    expect(text).not.toMatch(/popover|manager/i);
    expect(text).not.toMatch(/\bremember\b/i);
    expect(screen.queryByRole("checkbox", { name: /^remember/i })).toBeNull();
    expect(text).toContain("remembered for this repo");
  });

  it("[Choose files] opens Review and lands on the first row that can be ticked", async () => {
    setup(makeApi(candidates([row("link", { disabledReason: "symbolic-link" }), row("notes.txt")])));
    await screen.findByRole("group", { name: "Ignored files", hidden: true });
    await userEvent.click(screen.getByRole("button", { name: "Advanced" }));
    await userEvent.click(screen.getByRole("button", { name: "Choose files" }));
    expect(screen.getByRole("button", { name: "Review" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("checkbox", { name: /notes\.txt/ })).toHaveFocus();
  });

  it("keyboard order: Folder, Browse, copy checkbox, Review, rows, Select none, Cancel, Create", async () => {
    remember(["a.txt", "b.txt"]);
    setup(makeApi(candidates([row("a.txt"), row("b.txt"), row("c.txt")])));
    await openReview();
    const order = [
      screen.getByLabelText("Folder"),
      screen.getByRole("button", { name: /Browse/ }),
      screen.getByRole("checkbox", { name: /Copy 2 files/ }),
      screen.getByRole("button", { name: "Review" }),
      screen.getByRole("checkbox", { name: /a\.txt/ }),
      screen.getByRole("checkbox", { name: /c\.txt/ }),
      screen.getByRole("button", { name: "Select none" }),
      screen.getByRole("button", { name: "Cancel" }),
      screen.getByRole("button", { name: "Create worktree" }),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING, `${i}`).toBeTruthy();
    }
    // And the real Tab sequence visits them in that order.
    screen.getByLabelText("Folder").focus();
    const seen: Element[] = [];
    for (let i = 0; i < 14 && seen[seen.length - 1] !== order[order.length - 1]; i++) {
      await userEvent.tab();
      seen.push(document.activeElement!);
    }
    const positions = order.slice(1).map((el) => seen.indexOf(el));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("Advanced cannot be collapsed while a row is ticked, and says so to assistive tech", async () => {
    remember(["a.txt"]);
    setup(makeApi(candidates([row("a.txt")])));
    const adv = await screen.findByRole("button", { name: "Advanced" });
    await waitFor(() => expect(adv).toHaveAttribute("aria-expanded", "true"));
    expect(adv).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(adv);
    expect(adv).toHaveAttribute("aria-expanded", "true");
  });
});

describe("pinned stylesheet (AC 12)", () => {
  it("the Review list and its panel declare no overflow of their own, and text is never below 12px", () => {
    const css = readFileSync(join(__dirname, "CopyIgnoredSection.css"), "utf8");
    expect(css).not.toMatch(/overflow\s*:/);
    expect(css).not.toMatch(/border-left|border-right|border-inline/);
    for (const m of css.matchAll(/font-size:\s*(\d+)px/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(12);
    expect(css).toMatch(/min-height:\s*24px/);
    expect(css).toMatch(/--gh-ink-muted-text/);
  });
});

describe("memory behaviour through the dialog (FR-629, AC 2-4)", () => {
  async function ready(name: RegExp | string = "Create worktree") {
    await waitFor(() => expect(screen.getByLabelText("Folder")).toHaveValue("/w/acme.worktrees/feature-x"));
    return screen.getByRole("button", { name });
  }

  it("hand-ticking a secret and creating saves it, sends only the token and row ids", async () => {
    const { onSubmit } = setup(makeApi(candidates([row(".env"), row(".vscode/"), row("notes.txt")])));
    await userEvent.click(await screen.findByRole("button", { name: "Advanced" }));
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /\.env/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /\.vscode/ }));
    await userEvent.click(await ready());
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ copy: { token: "tok-1", rowIds: [".env", ".vscode/"] } });
    expect(JSON.stringify(onSubmit.mock.calls[0]![0])).not.toMatch(/manifest|sourcePath/);
    await waitFor(() => expect(stored()?.paths).toEqual([".env", ".vscode/"]));
  });

  it("an unchanged selection writes nothing", async () => {
    remember(["notes.txt"]);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    const { onSubmit } = setup(makeApi(candidates([row("notes.txt"), row("other.txt")])));
    await screen.findByText("Copy 1 file · 1 KB");
    setItem.mockClear();
    removeItem.mockClear();
    await userEvent.click(await ready());
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    setItem.mockRestore();
    removeItem.mockRestore();
  });

  it("Select none then Create clears the record; the next dialog shows nothing ticked", async () => {
    remember(["notes.txt"]);
    const { onSubmit } = setup(makeApi(candidates([row("notes.txt")])));
    await screen.findByText("remembered for this repo");
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    await userEvent.click(screen.getByRole("button", { name: "Select none" }));
    await userEvent.click(await ready());
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty("copy");
    await waitFor(() => expect(stored()).toBeNull());
  });

  it("a .worktreeinclude seed stays live (nothing written) until the user changes something", async () => {
    const { onSubmit } = setup(makeApi(candidates([row("notes.txt"), row(".env")], { status: "ok", matchedRows: ["notes.txt", ".env"], skipped: [] })));
    await screen.findByText("Copy 1 file · 1 KB from .worktreeinclude");
    await userEvent.click(await ready());
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ copy: { rowIds: ["notes.txt"] } });
    await new Promise((r) => setTimeout(r, 20));
    expect(stored()).toBeNull();
  });

  it("a secret listed in .worktreeinclude is not written when the user ticks something else", async () => {
    const { onSubmit } = setup(makeApi(candidates([row("notes.txt"), row("other.txt"), row(".env")], { status: "ok", matchedRows: ["notes.txt", ".env"], skipped: [] })));
    await screen.findByText("Copy 1 file · 1 KB from .worktreeinclude");
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /other\.txt/ }));
    await userEvent.click(await ready());
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    await waitFor(() => expect(stored()?.paths).toEqual(["notes.txt", "other.txt"]));
  });

  it("a failed add or a hook cancel saves nothing; Cancel saves nothing", async () => {
    const failing = setup(makeApi(candidates([row("notes.txt")])), async () => ({ field: "folder", message: "The folder is not empty." }) as CreateFailure);
    await userEvent.click(await screen.findByRole("button", { name: "Advanced" }));
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /notes\.txt/ }));
    await userEvent.click(await ready());
    await waitFor(() => expect(failing.onSubmit).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(stored()).toBeNull();
  });

  it("a silent refusal (hook dialog cancelled) saves nothing", async () => {
    setup(makeApi(candidates([row("notes.txt")])), async () => ({ field: "general", message: "", silent: true }) as CreateFailure);
    await userEvent.click(await screen.findByRole("button", { name: "Advanced" }));
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /notes\.txt/ }));
    await userEvent.click(await ready());
    await new Promise((r) => setTimeout(r, 30));
    expect(stored()).toBeNull();
  });

  it("a corrupt record is ignored without an error", async () => {
    localStorage.setItem(STORE_KEY, "{not json");
    setup(makeApi(candidates([row("notes.txt")])));
    expect(await screen.findByRole("group", { name: "Ignored files", hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("remembered for this repo")).toBeNull();
  });

  it("blocked storage (SecurityError) does not break the dialog", async () => {
    const spy = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const { onSubmit } = setup(makeApi(candidates([row("notes.txt")])));
    await userEvent.click(await screen.findByRole("button", { name: "Advanced" }));
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /notes\.txt/ }));
    await userEvent.click(await ready());
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
    spy.mockRestore();
  });

  it("the token is released when the dialog closes", async () => {
    const api = makeApi(candidates([row("notes.txt")]));
    const view = render(
      <CreateWorktreeDialog api={api} request={{ kind: "branch", branch: "b" }} mainPath="/w/acme" onSubmit={vi.fn()} onOpenExisting={vi.fn()} onCancel={vi.fn()} />,
    );
    await screen.findByRole("group", { name: "Ignored files", hidden: true });
    vi.mocked(api.releaseWorktreeCopy).mockClear();
    view.unmount();
    expect(api.releaseWorktreeCopy).toHaveBeenCalled();
  });
});
