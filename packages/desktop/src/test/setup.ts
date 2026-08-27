import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

// jsdom implements neither ResizeObserver nor the canvas 2D context — CommitGraph/GraphCanvas use
// both. Minimal stand-ins so component tests can render the real components rather than mocking
// them away entirely.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? ResizeObserverStub;

function makeFakeContext2D(): Partial<CanvasRenderingContext2D> {
  return {
    clearRect: () => {},
    fillRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    bezierCurveTo: () => {},
    stroke: () => {},
    fill: () => {},
    save: () => {},
    restore: () => {},
    setLineDash: () => {},
    scale: () => {},
  };
}

HTMLCanvasElement.prototype.getContext = ((): unknown => makeFakeContext2D()) as typeof HTMLCanvasElement.prototype.getContext;

// jsdom's layout engine always reports 0 for clientHeight/clientWidth (no real rendering), which
// would make virtualization math treat every viewport as zero-height. Give elements a reasonable
// default "viewport" so components under test behave as they would in a real window; individual
// tests can still override via Object.defineProperty on a specific element if needed.
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 1200 });
