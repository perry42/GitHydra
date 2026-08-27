import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("shows an explicit, non-blank status message (AC7)", () => {
    render(<EmptyState title="No commits yet" description="This repository has no commits." />);
    expect(screen.getByRole("status")).toHaveTextContent("No commits yet");
    expect(screen.getByText(/this repository has no commits/i)).toBeInTheDocument();
  });
});
