// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DiffView } from "./DiffView";
import type { FileDiffResult, ImageDiffResult } from "@githydra/git-core";

describe("DiffView", () => {
  it("shows a prompt when idle (no file selected)", () => {
    render(<DiffView fileLabel="src/a.ts" loading={false} errorMessage={null} result={null} />);
    expect(screen.getByText(/select a file to view its diff/i)).toBeInTheDocument();
  });

  it("shows a busy loading state", () => {
    render(<DiffView fileLabel="src/a.ts" loading={true} errorMessage={null} result={null} />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading diff/i);
  });

  it("surfaces an error", () => {
    render(<DiffView fileLabel="src/a.ts" loading={false} errorMessage="boom" result={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/could not load diff: boom/i);
  });

  it("shows a binary-file state (FR-21) instead of garbled content", () => {
    const result: FileDiffResult = { status: "binary", isBinary: true };
    render(<DiffView fileLabel="image.png" loading={false} errorMessage={null} result={result} />);
    expect(screen.getByText(/binary file/i)).toBeInTheDocument();
  });

  it("shows a too-large state with the changed-line count (FR-22)", () => {
    const result: FileDiffResult = {
      status: "too-large",
      isBinary: false,
      reason: "changed-lines",
      changedLineCount: 12000,
    };
    render(<DiffView fileLabel="huge.log" loading={false} errorMessage={null} result={result} />);
    expect(screen.getByText(/too large to display inline \(12,000 changed lines\)/i)).toBeInTheDocument();
  });

  it("renders add/remove/context lines with line numbers (AC3)", () => {
    const result: FileDiffResult = {
      status: "ok",
      isBinary: false,
      hunks: [
        {
          header: "@@ -1,2 +1,3 @@",
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          lines: [
            { type: "context", content: "unchanged", oldLineNumber: 1, newLineNumber: 1 },
            { type: "remove", content: "old line", oldLineNumber: 2, newLineNumber: null },
            { type: "add", content: "new line", oldLineNumber: null, newLineNumber: 2 },
            { type: "add", content: "another new line", oldLineNumber: null, newLineNumber: 3 },
          ],
        },
      ],
    };
    const { container } = render(
      <DiffView fileLabel="src/a.ts" loading={false} errorMessage={null} result={result} />,
    );

    expect(screen.getByText("unchanged")).toBeInTheDocument();
    expect(screen.getByText("old line")).toBeInTheDocument();
    expect(screen.getByText("new line")).toBeInTheDocument();

    const removeRow = screen.getByText("old line").closest(".gh-diff-view__line--remove");
    expect(removeRow).not.toBeNull();
    expect(removeRow).toHaveTextContent(/removed:/i);

    const addRow = screen.getByText("new line").closest(".gh-diff-view__line--add");
    expect(addRow).not.toBeNull();
    expect(addRow).toHaveTextContent(/added:/i);

    // Screen-reader-only add/remove/context wording never leaks into the visible marker column.
    expect(container.querySelectorAll(".gh-diff-view__line--remove .gh-diff-view__line-marker")[0]).toHaveTextContent("-");
    expect(container.querySelectorAll(".gh-diff-view__line--add .gh-diff-view__line-marker")[0]).toHaveTextContent("+");
  });

  // specs/image-diff-preview.md FR-144/FR-145/FR-146
  describe("image diff preview", () => {
    it("AC2: shows only the new image, labeled Added, for an added file — no old-image slot", () => {
      const imageResult: ImageDiffResult = {
        status: "ok",
        old: null,
        new: { base64: "bmV3", byteSize: 2048, mimeType: "image/jpeg" },
      };
      render(
        <DiffView fileLabel="icon.jpg" loading={false} errorMessage={null} result={null} imageResult={imageResult} />,
      );
      // FR-145: byte-size caption, reusing formatBytes — scoped to figcaption so this doesn't
      // also match the ancestor <figure> (which has no other text of its own).
      expect(screen.getByText(/Added · 2\.0 KB/, { selector: "figcaption" })).toBeInTheDocument();
      expect(screen.queryByText(/^Before/, { selector: "figcaption" })).not.toBeInTheDocument();
      expect(screen.queryByText(/^Deleted/, { selector: "figcaption" })).not.toBeInTheDocument();
      const images = screen.getAllByRole("img");
      expect(images).toHaveLength(1);
      expect(images[0]).toHaveAttribute("src", "data:image/jpeg;base64,bmV3");
      expect(images[0]).toHaveAttribute("alt", "Added version of icon.jpg");
    });

    it("AC3: shows only the old image, labeled Deleted, for a deleted file — no new-image slot", () => {
      const imageResult: ImageDiffResult = {
        status: "ok",
        old: { base64: "b2xk", byteSize: 512, mimeType: "image/gif" },
        new: null,
      };
      render(
        <DiffView fileLabel="anim.gif" loading={false} errorMessage={null} result={null} imageResult={imageResult} />,
      );
      expect(screen.getByText(/Deleted · 512 B/, { selector: "figcaption" })).toBeInTheDocument();
      expect(screen.queryByText(/^Added/, { selector: "figcaption" })).not.toBeInTheDocument();
      const images = screen.getAllByRole("img");
      expect(images).toHaveLength(1);
      expect(images[0]).toHaveAttribute("src", "data:image/gif;base64,b2xk");
    });

    it("AC1/AC4: shows both images side by side, labeled Before/After, with byte sizes, for a modified/renamed file", () => {
      const imageResult: ImageDiffResult = {
        status: "ok",
        old: { base64: "b2xk", byteSize: 100, mimeType: "image/x-icon" },
        new: { base64: "bmV3", byteSize: 300, mimeType: "image/x-icon" },
      };
      render(
        <DiffView
          fileLabel="old.ico -> new.ico"
          loading={false}
          errorMessage={null}
          result={null}
          imageResult={imageResult}
        />,
      );
      expect(screen.getByText(/Before · 100 B/, { selector: "figcaption" })).toBeInTheDocument();
      expect(screen.getByText(/After · 300 B/, { selector: "figcaption" })).toBeInTheDocument();
      const images = screen.getAllByRole("img");
      expect(images).toHaveLength(2);
      expect(images[0]).toHaveAttribute("src", "data:image/x-icon;base64,b2xk");
      expect(images[1]).toHaveAttribute("src", "data:image/x-icon;base64,bmV3");
    });

    it("AC5: an .svg still renders as an image (not a text hunk diff) even though DiffView treats it no differently from any other image mime type", () => {
      const imageResult: ImageDiffResult = {
        status: "ok",
        old: null,
        new: { base64: "PHN2Zz48L3N2Zz4=", byteSize: 16, mimeType: "image/svg+xml" },
      };
      render(
        <DiffView fileLabel="logo.svg" loading={false} errorMessage={null} result={null} imageResult={imageResult} />,
      );
      const images = screen.getAllByRole("img");
      expect(images).toHaveLength(1);
      expect(images[0]).toHaveAttribute("src", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=");
      // Rendered as <img>, never dangerouslySetInnerHTML — no raw <svg> element in the DOM.
      expect(document.querySelector("svg")).not.toBeInTheDocument();
    });

    it("AC7/FR-146: an image too-large result reuses the existing too-large text/pattern", () => {
      const imageResult: ImageDiffResult = { status: "too-large", side: "new" };
      render(
        <DiffView fileLabel="huge.png" loading={false} errorMessage={null} result={null} imageResult={imageResult} />,
      );
      expect(screen.getByText(/too large to display inline/i)).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("FR-147: an image-diff load failure reuses the existing generic error state", () => {
      render(
        <DiffView fileLabel="broken.png" loading={false} errorMessage="boom" result={null} imageResult={null} />,
      );
      expect(screen.getByRole("alert")).toHaveTextContent(/could not load diff: boom/i);
    });

    it("does not affect callers that never pass imageResult (existing binary-file behavior)", () => {
      const result: FileDiffResult = { status: "binary", isBinary: true };
      render(<DiffView fileLabel="archive.zip" loading={false} errorMessage={null} result={result} />);
      expect(screen.getByText(/binary file/i)).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });
  });
});
