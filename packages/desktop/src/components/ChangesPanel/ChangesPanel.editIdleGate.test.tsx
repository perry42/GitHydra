// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { file, list, mountPanel } from "../../test/changesPanelHarness";
import { polyfillCodeMirrorDom, typeAtEnd } from "../../test/codemirrorDom";

// specs/live-refresh.md FR-465: the block editor is the old conflict view's successor for the idle gate.

beforeAll(polyfillCodeMirrorDom);

const H = (c: string) => c.repeat(64);
const readOk = (content: string) => ({
  ok: true as const,
  data: {
    eligible: true as const, hasStagedContent: false, isNew: false, isUntracked: false, size: 1, mtimeMs: 1, mode: 0o644,
    content, eol: "lf" as const, hasBom: false, finalNewline: true, contentHash: H("a"),
  },
});
const rowButton = (name: string, section: string) => document.querySelector<HTMLElement>(`[data-row-key="${section}:${name}"]`)!;
const busy = (fn: ReturnType<typeof vi.fn>) => (fn.mock.lastCall![0] as { conflictViewOpen: boolean }).conflictViewOpen;

describe("ChangesPanel idle gate with the editor open (FR-465)", () => {
  it("a clean editor on an ordinary file is idle; unsaved text makes it busy; leaving the editor clears it", async () => {
    const onInteractionChange = vi.fn();
    const { api, container } = mountPanel(list({ unstaged: [file("a.txt", "unstaged")] }), { onInteractionChange });
    (api.readEditableFile as ReturnType<typeof vi.fn>).mockImplementation(() => Promise.resolve(readOk("body\n")));
    fireEvent.click(rowButton("a.txt", "unstaged"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("textbox", { name: /Editing/ });
    expect(busy(onInteractionChange)).toBe(false);
    act(() => typeAtEnd(container, "x"));
    await waitFor(() => expect(busy(onInteractionChange)).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Close changes panel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(busy(onInteractionChange)).toBe(false));
  });

  it("an editor open on a conflicted file is busy even before any typing", async () => {
    const onInteractionChange = vi.fn();
    const { api } = mountPanel(list({ conflicted: [file("c.txt", "conflicted", "both-modified" as never)] }), { onInteractionChange });
    (api.readEditableFile as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve(readOk("<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> feature\n")),
    );
    fireEvent.click(rowButton("c.txt", "conflicted"));
    await screen.findByRole("textbox", { name: /Editing c\.txt/ });
    await waitFor(() => expect(busy(onInteractionChange)).toBe(true));
  });
});
