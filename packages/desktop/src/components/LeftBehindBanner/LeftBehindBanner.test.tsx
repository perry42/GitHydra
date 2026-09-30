// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LeftBehindBanner, leftBehindMessage } from "./LeftBehindBanner";

const info = { headSha: "abcdef1".padEnd(40, "0"), shortSha: "abcdef1", total: 3, totalIsCapped: false, unknown: false };

describe("LeftBehindBanner (FR-430)", () => {
  it("messages: plural, singular, capped, unknown", () => {
    expect(leftBehindMessage(info)).toBe("Left 3 commits behind at abcdef1");
    expect(leftBehindMessage({ ...info, total: 1 })).toBe("Left 1 commit behind at abcdef1");
    expect(leftBehindMessage({ ...info, total: 1000, totalIsCapped: true })).toBe("Left 1000+ commits behind at abcdef1");
    expect(leftBehindMessage({ ...info, unknown: true })).toBe("Left possibly unsaved commits behind at abcdef1");
  });

  it("offers Create branch at <sha> and Dismiss, announced politely", async () => {
    const onCreateBranch = vi.fn();
    const onDismiss = vi.fn();
    render(<LeftBehindBanner info={info} onCreateBranch={onCreateBranch} onDismiss={onDismiss} />);
    expect(screen.getByRole("status")).toHaveTextContent("Left 3 commits behind at abcdef1");
    await userEvent.click(screen.getByRole("button", { name: "Create branch at abcdef1" }));
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onCreateBranch).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
