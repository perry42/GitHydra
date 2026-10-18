// SPDX-License-Identifier: GPL-3.0-or-later
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HookConsentDialog, HOOK_EXPLANATION, notShownText, type PresentHookInfo } from "./HookConsentDialog";

const info = (over: Partial<PresentHookInfo> = {}): PresentHookInfo => ({
  present: true,
  hookPath: "C:/repo/.git/hooks/post-checkout",
  hooksDir: "C:/repo/.git/hooks",
  hooksPathConfig: null,
  hooksPathRelative: false,
  contentSha256: "a".repeat(64),
  size: 42,
  executable: true,
  otherHooks: [],
  fingerprint: "b".repeat(64),
  preview: "#!/bin/sh\necho hi",
  previewTruncated: false,
  previewLineCount: 2,
  previewIsBinary: false,
  remembered: null,
  ...over,
});

function setup(over: Partial<PresentHookInfo> = {}, extra: { notice?: string } = {}) {
  const onChoose = vi.fn();
  const onCancel = vi.fn();
  render(<HookConsentDialog info={info(over)} onChoose={onChoose} onCancel={onCancel} {...extra} />);
  return { onChoose, onCancel };
}

describe("HookConsentDialog (specs/worktrees.md FR-644, AC 21)", () => {
  it("explains in plain words, shows path, core.hooksPath, size and lines, and the preview", () => {
    setup({ hooksPathConfig: "C:/shared/hooks", size: 2048, previewLineCount: 2 });
    expect(screen.getByText(HOOK_EXPLANATION)).toBeInTheDocument();
    expect(screen.getByText("C:/repo/.git/hooks/post-checkout")).toBeInTheDocument();
    expect(screen.getByText("C:/shared/hooks")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB, 2 lines")).toBeInTheDocument();
    expect(screen.getByLabelText("Hook contents, read only").textContent).toBe("#!/bin/sh\necho hi");
    expect(screen.getByText(/runs from a private copy/i)).toHaveTextContent("A hook that looks for files next to itself, or a temp folder that does not allow running programs, can fail.");
  });

  it("puts the first focus on Cancel and never defaults to Run hook", () => {
    setup();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    // Order: Cancel, Run hook, Skip hook. Skip is the filled (primary) button, Run is the neutral one.
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual(["Cancel", "Run hook", "Skip hook"]);
    expect(screen.getByRole("button", { name: "Skip hook" }).className).toContain("gh-confirm-dialog__confirm");
    expect(screen.getByRole("button", { name: "Run hook" }).className).not.toContain("gh-confirm-dialog__confirm");
  });

  it("Enter on the initially focused control (Cancel) creates nothing and chooses nothing", async () => {
    const { onChoose, onCancel } = setup();
    await userEvent.keyboard("{Enter}");
    expect(onChoose).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Esc cancels", async () => {
    const { onChoose, onCancel } = setup();
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalled();
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("is keyboard-complete: Tab reaches the preview, the remember checkbox and every button", async () => {
    setup();
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      await userEvent.tab();
      seen.push(document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? document.activeElement?.tagName ?? "");
    }
    expect(seen).toContain("Hook contents, read only");
    expect(seen.some((s) => s === "" || /Remember/.test(s))).toBe(true);
    expect(seen).toContain("Run hook");
    expect(seen).toContain("Skip hook");
  });

  it("remember is off by default and is passed with the choice", async () => {
    const { onChoose } = setup();
    const box = screen.getByRole("checkbox", { name: "Remember my choice for this repository" });
    expect(box).not.toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Run hook" }));
    expect(onChoose).toHaveBeenLastCalledWith("run", false);
    await userEvent.click(box);
    await userEvent.click(screen.getByRole("button", { name: "Skip hook" }));
    expect(onChoose).toHaveBeenLastCalledWith("skip", true);
  });

  it("a truncated preview says how many lines are not shown", () => {
    setup({ previewTruncated: true, previewLineCount: 120, preview: Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n") });
    expect(screen.getByText("100 more lines not shown")).toBeInTheDocument();
    expect(notShownText(info({ previewTruncated: true, previewLineCount: 3, preview: "a\nb\nc" }))).toBe("More of this file is not shown");
  });

  it("a binary file says it is not text and shows no preview", () => {
    setup({ previewIsBinary: true, preview: "garbage" });
    expect(screen.getByText(/This file is not text\./)).toBeInTheDocument();
    expect(screen.queryByLabelText("Hook contents, read only")).toBeNull();
  });

  it("lists the other hooks and says they stay disabled", () => {
    setup({ otherHooks: ["pre-commit", "reference-transaction"] });
    expect(screen.getByText(/These stay disabled\./)).toHaveTextContent("pre-commit, reference-transaction");
  });

  it("a relative core.hooksPath hides Remember, disables Run hook and gives the reason", () => {
    const { onChoose } = setup({ hooksPathRelative: true, hooksPathConfig: ".githooks" });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Run hook" })).toBeDisabled();
    expect(screen.getByText(/relative path/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Skip hook" }));
    expect(onChoose).toHaveBeenCalledWith("skip", false);
  });

  it("makes right-to-left and invisible characters visible in the path, the config value and the preview", () => {
    setup({
      hookPath: "C:/r/hooks/post\u202Echeckout",
      hooksPathConfig: "C:/h\u200Bx",
      preview: "echo \u202Ehidden",
      otherHooks: ["a\u2066b"],
    });
    expect(screen.getByText("C:/r/hooks/post\\u{202e}checkout")).toBeInTheDocument();
    expect(screen.getByText("C:/h\\u{200b}x")).toBeInTheDocument();
    expect(screen.getByLabelText("Hook contents, read only").textContent).toBe("echo \\u{202e}hidden");
    expect(document.body.textContent).not.toMatch(/[\u202E\u200B\u2066]/);
  });

  it("renders markup in the hook as plain text (no HTML injection)", () => {
    setup({ preview: "<img src=x onerror=alert(1)>" });
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByLabelText("Hook contents, read only").textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("shows a refusal notice as an alert", () => {
    setup({}, { notice: "The hook changed since it was shown. Review it again." });
    expect(screen.getByRole("alert")).toHaveTextContent("The hook changed since it was shown.");
  });
});
