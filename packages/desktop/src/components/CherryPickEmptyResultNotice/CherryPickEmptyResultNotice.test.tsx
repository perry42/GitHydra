import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CherryPickEmptyResultNotice } from "./CherryPickEmptyResultNotice";

describe("CherryPickEmptyResultNotice (specs/cherry-pick.md FR-118)", () => {
  it("names the paused commit's short SHA + subject and offers Skip / Commit-empty (AC7)", () => {
    render(
      <CherryPickEmptyResultNotice
        targetSha="a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
        targetSubject="Fix off-by-one"
        onSkip={() => {}}
        onCommitEmpty={() => {}}
        busy={false}
      />,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("a1b2c3d");
    expect(status).toHaveTextContent(/Fix off-by-one/);
    expect(status).toHaveTextContent(/already present on this branch/i);
    expect(screen.getByRole("button", { name: /skip this commit/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /commit anyway \(empty\)/i })).toBeEnabled();
  });

  it("calls onSkip when Skip is clicked", async () => {
    const onSkip = vi.fn();
    render(
      <CherryPickEmptyResultNotice
        targetSha="a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
        targetSubject={null}
        onSkip={onSkip}
        onCommitEmpty={() => {}}
        busy={false}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /skip this commit/i }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("calls onCommitEmpty when Commit anyway is clicked", async () => {
    const onCommitEmpty = vi.fn();
    render(
      <CherryPickEmptyResultNotice
        targetSha="a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
        targetSubject={null}
        onSkip={() => {}}
        onCommitEmpty={onCommitEmpty}
        busy={false}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /commit anyway \(empty\)/i }));
    expect(onCommitEmpty).toHaveBeenCalledTimes(1);
  });

  it("neither action is auto-applied — both stay inert until explicitly clicked", () => {
    const onSkip = vi.fn();
    const onCommitEmpty = vi.fn();
    render(
      <CherryPickEmptyResultNotice
        targetSha="a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
        targetSubject="Fix off-by-one"
        onSkip={onSkip}
        onCommitEmpty={onCommitEmpty}
        busy={false}
      />,
    );
    expect(onSkip).not.toHaveBeenCalled();
    expect(onCommitEmpty).not.toHaveBeenCalled();
  });

  it("disables both actions (with non-color-only busy copy) while busy", () => {
    render(
      <CherryPickEmptyResultNotice
        targetSha="a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
        targetSubject="Fix off-by-one"
        onSkip={() => {}}
        onCommitEmpty={() => {}}
        busy={true}
      />,
    );
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent(/working/i);
    }
  });
});
