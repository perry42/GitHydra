import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RecentRepoRow } from "./RecentRepoRow";

describe("RecentRepoRow", () => {
  it("shows the derived tab-label and full path (as a title tooltip)", () => {
    render(<RecentRepoRow path="/home/user/my-repo" notFound={false} onOpen={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("my-repo")).toBeInTheDocument();
    expect(screen.getByTitle("/home/user/my-repo")).toBeInTheDocument();
  });

  it("calls onOpen with the path when clicked", async () => {
    const onOpen = vi.fn();
    render(<RecentRepoRow path="/repoA" notFound={false} onOpen={onOpen} onRemove={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /repoA/i }));
    expect(onOpen).toHaveBeenCalledWith("/repoA");
  });

  it("disables the row when busy", () => {
    render(<RecentRepoRow path="/repoA" busy notFound={false} onOpen={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByRole("button", { name: /repoA/i })).toBeDisabled();
  });

  it("AC6: renders the inline not-found state with a 'Remove from list' action instead of a clickable row", async () => {
    const onRemove = vi.fn();
    render(<RecentRepoRow path="/repoGone" notFound onOpen={vi.fn()} onRemove={onRemove} />);
    expect(screen.getByText(/not found/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^repoGone/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /remove from list/i }));
    expect(onRemove).toHaveBeenCalledWith("/repoGone");
  });
});
