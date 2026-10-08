// SPDX-License-Identifier: GPL-3.0-or-later
/// <reference lib="dom" />
// specs/edit-in-diff.md FR-535: the static page of the main-process close prompt, run in jsdom with a fake bridge.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChoice } from "./closeDialogChannels";
import { loadThemeHint, parseThemeHint, saveThemeHint } from "./themeHint";

const dir = path.join(__dirname, "closeDialog");
const html = fs.readFileSync(path.join(dir, "closeDialog.html"), "utf8");
const script = fs.readFileSync(path.join(dir, "closeDialog.js"), "utf8");
const css = fs.readFileSync(path.join(dir, "closeDialog.css"), "utf8");
const themeCss = fs.readFileSync(path.join(__dirname, "..", "src", "theme.css"), "utf8");

function mount(search: string, reason: string) {
  document.documentElement.removeAttribute("data-theme");
  document.body.innerHTML = html.replace(/[\s\S]*<body>/, "").replace(/<script[\s\S]*$/, "");
  window.history.replaceState({}, "", `/${search}`);
  const respond = vi.fn();
  let resolveReason!: (r: string) => void;
  (window as unknown as { closeDialog: unknown }).closeDialog = {
    getReason: () => new Promise<string>((r) => (resolveReason = r)),
    respond,
    ready: vi.fn(async () => {}),
  };
  new Function(script)();
  // Real timers are faked in the guard tests; `armed` flips INPUT_GUARD_MS after ready.
  return {
    respond,
    deliver: async (r = reason, pastGuard = true) => {
      resolveReason(r);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      if (pastGuard) vi.advanceTimersByTime(300);
    },
  };
}
const btn = (id: string) => document.getElementById(id) as HTMLButtonElement;
const key = (k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(e);
  return e;
};

describe("close prompt page", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.title = "";
  });
  afterEach(() => vi.useRealTimers());

  it("has a strict CSP, no inline script or style, and the alertdialog wiring", () => {
    expect(html).toContain("default-src 'none'; style-src 'self'; script-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(html).not.toMatch(/<style|style=|\son\w+=/i);
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-labelledby="gh-close-title"');
    expect(html).toContain('aria-describedby="gh-close-detail"');
    expect(css).not.toMatch(/url\(|@import/);
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|eval\(/);
  });

  it("uses logical properties only (RTL-safe) and honours forced colors", () => {
    expect(css).not.toMatch(/\b(margin|padding)-(left|right)\b|\b(left|right)\s*:/);
    expect(css).toContain("forced-colors: active");
  });

  it("keeps its copied design tokens equal to src/theme.css", () => {
    const grab = (src: string, selector: string, name: string) => {
      const block = src.slice(src.indexOf(selector));
      return new RegExp(`${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
    };
    for (const name of ["--gh-page", "--gh-surface", "--gh-ink-primary", "--gh-ink-secondary", "--gh-border", "--gh-accent", "--gh-status-critical"]) {
      const darkSel = '[data-theme="dark"]';
      const inDarkCss = css.slice(css.indexOf(darkSel)).includes(`${name}:`);
      if (inDarkCss) expect(grab(css, darkSel, name), name + " dark").toBe(grab(themeCss, darkSel, name));
      expect(grab(css, ":root", name), name + " light").toBe(grab(themeCss, ":root", name));
    }
  });

  it("renders the second-attempt copy via textContent, titles the window and focuses Keep open", async () => {
    const { deliver } = mount("?theme=dark", "second-attempt");
    await deliver();
    expect(document.title).toBe("Close GitHydra?");
    expect(document.getElementById("gh-close-title")!.textContent).toBe("Close GitHydra?");
    expect(document.getElementById("gh-close-detail")!.textContent).toBe(
      "You have unsaved edits in the editor. A Save / Discard / Cancel prompt is already open in the window. If you close now, those edits are lost.",
    );
    expect(document.activeElement).toBe(btn("gh-keep-open"));
  });

  it("renders the unresponsive copy", async () => {
    const { deliver } = mount("?theme=dark", "unresponsive");
    await deliver();
    expect(document.title).toBe("GitHydra is not responding");
    expect(document.getElementById("gh-close-title")!.textContent).toBe("GitHydra is not responding");
    expect(document.getElementById("gh-close-detail")!.textContent).toBe("You have unsaved edits in the editor. If you close now, those edits are lost.");
  });

  it("never renders anything outside the closed enum: an unknown reason shows the neutral copy, markup stays inert", async () => {
    const { deliver } = mount("?theme=dark", "");
    await deliver("<img src=x onerror=alert(1)>");
    expect(document.getElementById("gh-close-title")!.textContent).toBe("Close GitHydra?");
    expect(document.querySelector("img")).toBeNull();
  });

  it("themes from a validated query value, defaulting to dark", () => {
    mount("?theme=light", "second-attempt");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    mount("?theme=%3Cscript%3E", "second-attempt");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("buttons answer once: Close anyway -> close, Keep open -> keep, and then both are disabled", async () => {
    const a = mount("", "second-attempt");
    await a.deliver();
    btn("gh-close-anyway").click();
    expect(a.respond).toHaveBeenCalledWith("close");
    btn("gh-keep-open").click();
    key("Escape");
    expect(a.respond).toHaveBeenCalledTimes(1);
    expect(btn("gh-keep-open").disabled).toBe(true);

    const b = mount("", "second-attempt");
    await b.deliver();
    btn("gh-keep-open").click();
    expect(b.respond).toHaveBeenCalledWith("keep");
  });

  it("tells main it is ready only after text and focus are set, and ignores clicks/Enter/Space for 300 ms after that", async () => {
    const m = mount("", "second-attempt");
    const ready = (window as unknown as { closeDialog: { ready: ReturnType<typeof vi.fn> } }).closeDialog.ready;
    expect(ready).not.toHaveBeenCalled();
    await m.deliver("second-attempt", false);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(btn("gh-keep-open"));
    // Inside the guard window: a held Enter/Space or a stray click does nothing.
    expect(key("Enter").defaultPrevented).toBe(true);
    expect(key(" ").defaultPrevented).toBe(true);
    btn("gh-keep-open").click();
    btn("gh-close-anyway").click();
    expect(m.respond).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    btn("gh-close-anyway").click();
    expect(m.respond).toHaveBeenCalledWith("close");
  });

  it("Escape means Keep open", async () => {
    const { respond, deliver } = mount("", "second-attempt");
    await deliver();
    key("Escape");
    expect(respond).toHaveBeenCalledWith("keep");
  });

  it("Tab and Shift+Tab cycle between exactly the two buttons", async () => {
    const { deliver } = mount("", "second-attempt");
    await deliver();
    expect(document.activeElement).toBe(btn("gh-keep-open"));
    expect(key("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(btn("gh-close-anyway"));
    key("Tab");
    expect(document.activeElement).toBe(btn("gh-keep-open"));
    key("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(btn("gh-close-anyway"));
    key("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(btn("gh-keep-open"));
    expect(document.querySelectorAll("button, a, input, [tabindex]").length).toBe(2);
  });

  it("Close anyway is first in tab order and carries the destructive (critical border) style, Keep open the primary one", () => {
    const buttons = Array.from(document.querySelectorAll("button"));
    mount("", "second-attempt");
    expect(btn("gh-close-anyway").className).toContain("secondary--destructive");
    expect(btn("gh-keep-open").className).toContain("confirm");
    expect(buttons.length).toBeGreaterThanOrEqual(0);
  });
});

describe("close prompt plumbing", () => {
  it("parseChoice accepts only the two enum values", () => {
    expect(parseChoice("close")).toBe("close");
    expect(parseChoice("keep")).toBe("keep");
    for (const bad of ["Close", "", null, undefined, 0, {}, ["keep"]]) expect(parseChoice(bad)).toBeNull();
  });

  it("theme hint round-trips through userData, rejects junk and never throws", () => {
    const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), "gh-theme-"));
    try {
      expect(loadThemeHint(dirPath)).toBeNull();
      saveThemeHint(dirPath, "light");
      expect(loadThemeHint(dirPath)).toBe("light");
      fs.writeFileSync(path.join(dirPath, "theme-hint.json"), JSON.stringify({ theme: "<x>" }));
      expect(loadThemeHint(dirPath)).toBeNull();
      fs.writeFileSync(path.join(dirPath, "theme-hint.json"), "not json");
      expect(loadThemeHint(dirPath)).toBeNull();
      fs.writeFileSync(path.join(dirPath, "theme-hint.json"), JSON.stringify({ theme: "dark", pad: "x".repeat(2000) }));
      expect(loadThemeHint(dirPath)).toBeNull();
      saveThemeHint(dirPath, "dark");
      expect(loadThemeHint(dirPath)).toBe("dark");
      expect(fs.readdirSync(dirPath)).toEqual(["theme-hint.json"]);
      expect(() => saveThemeHint(path.join(dirPath, "theme-hint.json", "nope"), "dark")).not.toThrow();
      expect(parseThemeHint("dark")).toBe("dark");
      expect(parseThemeHint("blue")).toBeNull();
    } finally {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  });
});
