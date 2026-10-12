// SPDX-License-Identifier: GPL-3.0-or-later
// specs/edit-in-diff.md FR-593/FR-599: every way of opening a conflicted file lands in read-only Resolving, and re-opening a file
// that is already being edited never resets it.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { file, list, mountPanel } from "../../test/changesPanelHarness";
import { polyfillCodeMirrorDom, viewOf } from "../../test/codemirrorDom";

beforeAll(polyfillCodeMirrorDom);

const TEXT = ["head", "<<<<<<< HEAD", "top1", "=======", "bot1", ">>>>>>> feature", "tail", ""].join("\n");
const readOk = (content: string) => ({
  ok: true as const,
  data: { eligible: true as const, hasStagedContent: false, isNew: false, isUntracked: false, conflicted: true, size: 3, mtimeMs: 1, mode: 0o644, content, eol: "lf" as const, hasBom: false, finalNewline: true, contentHash: "a".repeat(64) },
});
const side = (text: string) => ({ status: "ok" as const, sha: "a".repeat(40), mode: "100644", text });
const sides = { base: side("b\n"), ours: side("top1\n"), theirs: side("bot1\n") };
const labels = { ours: { label: "Your branch (main @ abc1234)", refName: "main", sha: "abc1234" }, theirs: { label: "Incoming (feature @ def5678)", refName: "feature", sha: "def5678" } };

function mount(extra: Parameters<typeof mountPanel>[1] = {}) {
  const m = mountPanel(list({ conflicted: [file("x.ts", "conflicted", "unmerged")] }), extra, { conflictSides: sides, conflictSideLabels: labels } as never);
  (m.api.readEditableFile as ReturnType<typeof vi.fn>).mockImplementation(() => Promise.resolve(readOk(TEXT)));
  return m;
}
const tag = () => document.querySelector(".gh-edit__bar .gh-edit__tag-text")?.textContent;

describe("ChangesPanel opens conflicted files read-only (FR-593)", () => {
  it("a row click lands in Resolving", async () => {
    mount();
    await waitFor(() => expect(document.querySelector('[data-row-key="conflicted:x.ts"]')).not.toBeNull());
    fireEvent.click(document.querySelector<HTMLElement>('[data-row-key="conflicted:x.ts"]')!);
    await screen.findByRole("textbox", { name: "Editing x.ts" });
    expect(tag()).toBe("Resolving");
    expect(viewOf(document.body).state.readOnly).toBe(true);
  });

  it("the automatic open of the first conflict (FR-575) lands in Resolving without text focus", async () => {
    mount({ operationLabel: "merge" });
    const ed = await screen.findByRole("textbox", { name: "Editing x.ts" });
    expect(tag()).toBe("Resolving");
    expect(viewOf(document.body).state.readOnly).toBe(true);
    await waitFor(() => expect(ed).not.toHaveFocus());
  });

  it("clicking the row of the file you are already editing keeps Editing and the same editor", async () => {
    mount({ operationLabel: "merge" });
    const ed = await screen.findByRole("textbox", { name: "Editing x.ts" });
    fireEvent.keyDown(ed, { key: "e", code: "KeyE" });
    await waitFor(() => expect(tag()).toBe("Editing"));
    const view = viewOf(document.body);
    fireEvent.click(document.querySelector<HTMLElement>('[data-row-key="conflicted:x.ts"]')!);
    await new Promise((r) => setTimeout(r, 50));
    expect(tag()).toBe("Editing");
    expect(viewOf(document.body)).toBe(view);
    expect(view.state.readOnly).toBe(false);
  });
});
