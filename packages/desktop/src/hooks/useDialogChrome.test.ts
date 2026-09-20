// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { createElement, useRef } from "react";
import { useDialogChrome, type UseDialogChromeOptions } from "./useDialogChrome";

/**
 * A minimal host component exercising `useDialogChrome` against a real overlay/panel DOM shape —
 * matching the `<div overlay onMouseDown={...}><div panel><button/></div></div>` structure every
 * migrated dialog actually renders, rather than testing the hook against `renderHook`'s bare
 * wrapper (which has no DOM shape to click a "backdrop" on).
 */
function Host(props: Partial<UseDialogChromeOptions> & { onEscape: () => void }) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const { onOverlayMouseDown } = useDialogChrome({
    getFocusTarget: () => panelRef.current?.querySelector<HTMLElement>("button") ?? null,
    ...props,
  });
  return createElement(
    "div",
    { "data-testid": "overlay", onMouseDown: onOverlayMouseDown },
    createElement(
      "div",
      { "data-testid": "panel", ref: panelRef },
      createElement("button", { type: "button" }, "First control"),
    ),
  );
}

describe("useDialogChrome", () => {
  it("focuses the first control on mount", () => {
    const { getByRole } = render(createElement(Host, { onEscape: vi.fn() }));
    expect(getByRole("button", { name: "First control" })).toHaveFocus();
  });

  it("calls onEscape on Escape", () => {
    const onEscape = vi.fn();
    render(createElement(Host, { onEscape }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("does not call onEscape when escapeActive is false", () => {
    const onEscape = vi.fn();
    render(createElement(Host, { onEscape, escapeActive: false }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("routes Escape through the caller's own intercept logic instead of a fixed close call", () => {
    // Mirrors CloneDialog: Escape cancels an in-flight operation instead of closing, based on a
    // reactive value threaded through `escapeDeps`.
    const cancel = vi.fn();
    const close = vi.fn();
    function InterceptHost({ phase }: { phase: "idle" | "busy" }) {
      const { onOverlayMouseDown } = useDialogChrome({
        onEscape: () => (phase === "busy" ? cancel() : close()),
        escapeDeps: [phase],
      });
      return createElement("div", { "data-testid": "overlay", onMouseDown: onOverlayMouseDown });
    }
    const { rerender } = render(createElement(InterceptHost, { phase: "busy" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();

    rerender(createElement(InterceptHost, { phase: "idle" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("calls onBackdropClick when the overlay itself (not a bubbled child click) is clicked", () => {
    const onBackdropClick = vi.fn();
    const { getByTestId } = render(createElement(Host, { onEscape: vi.fn(), onBackdropClick }));

    fireEvent.mouseDown(getByTestId("panel"));
    expect(onBackdropClick).not.toHaveBeenCalled();

    fireEvent.mouseDown(getByTestId("overlay"));
    expect(onBackdropClick).toHaveBeenCalledTimes(1);
  });

  it("does not call onBackdropClick when backdropActive is false", () => {
    const onBackdropClick = vi.fn();
    const { getByTestId } = render(
      createElement(Host, { onEscape: vi.fn(), onBackdropClick, backdropActive: false }),
    );
    fireEvent.mouseDown(getByTestId("overlay"));
    expect(onBackdropClick).not.toHaveBeenCalled();
  });

  it("re-focuses the first control whenever escapeDeps changes when refocusWithEscapeEffect is set", () => {
    function RefocusHost({ dep }: { dep: number }) {
      const panelRef = useRef<HTMLDivElement | null>(null);
      const inputRef = useRef<HTMLInputElement | null>(null);
      const { onOverlayMouseDown } = useDialogChrome({
        onEscape: vi.fn(),
        escapeDeps: [dep],
        refocusWithEscapeEffect: true,
        getFocusTarget: () => panelRef.current?.querySelector<HTMLElement>("button") ?? null,
      });
      return createElement(
        "div",
        { onMouseDown: onOverlayMouseDown },
        createElement(
          "div",
          { ref: panelRef },
          createElement("button", { type: "button" }, "Control"),
        ),
        createElement("input", { ref: inputRef, "aria-label": "typing target" }),
      );
    }
    const { getByRole, rerender } = render(createElement(RefocusHost, { dep: 0 }));
    const input = getByRole("textbox", { name: "typing target" });
    input.focus();
    expect(input).toHaveFocus();

    // Unrelated re-render (dep unchanged) must not steal focus back.
    rerender(createElement(RefocusHost, { dep: 0 }));
    expect(input).toHaveFocus();

    // A real dep change re-runs the effect and refocuses the first control.
    rerender(createElement(RefocusHost, { dep: 1 }));
    expect(getByRole("button", { name: "Control" })).toHaveFocus();
  });
});
