import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StatusBanner } from "./StatusBanner";
import { makeRepoState } from "../../test/fixtures";

describe("StatusBanner", () => {
  it("renders nothing for a plain, up-to-date repo", () => {
    const { container } = render(
      <StatusBanner repoState={makeRepoState()} hasExternalChanges={false} onRefresh={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("labels an in-progress rebase rather than silently rendering HEAD as normal (FR-5)", () => {
    render(
      <StatusBanner
        repoState={makeRepoState({ inProgressOperation: "rebase" })}
        hasExternalChanges={false}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText(/rebase in progress/i)).toBeInTheDocument();
  });

  it("flags detached HEAD (AC4 supporting text)", () => {
    render(
      <StatusBanner
        repoState={makeRepoState({ isDetachedHead: true, currentBranch: null })}
        hasExternalChanges={false}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText(/detached head/i)).toBeInTheDocument();
  });

  it("offers a manual refresh action when history changed externally (FR-6/AC11)", async () => {
    const onRefresh = vi.fn();
    render(<StatusBanner repoState={makeRepoState()} hasExternalChanges onRefresh={onRefresh} />);
    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalled();
  });
});
