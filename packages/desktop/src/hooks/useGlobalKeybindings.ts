// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { getCommands, type CommandContext } from "../lib/commands";
import { matchesKeyCombo } from "../lib/platform";

export interface UseGlobalKeybindingsOptions {
  /** FR-223: the live command context — a fresh object every render (cheap: plain values + stable
   * callback references), read through a ref inside the listener below so this hook never needs to
   * tear down/re-attach its one `keydown` listener just because a new object identity showed up. */
  ctx: CommandContext;
  /**
   * FR-221: true whenever an existing App-owned modal dialog (New Branch, New Stash, the branch
   * delete/force-delete Confirm dialog) is currently open — checked via the exact same
   * dialog-visibility state `App.tsx` already tracks. This layer is entirely inert while `true`,
   * deferring to that dialog's own local `keydown` handler exactly as FR-221 requires, rather than
   * inventing a new focus-trap mechanism.
   */
  dialogOpen: boolean;
}

export interface UseGlobalKeybindingsResult {
  paletteOpen: boolean;
  openPalette: () => void;
  closePalette: () => void;
}

/**
 * specs/keyboard-shortcuts-command-palette.md FR-221/FR-226/FR-227/FR-229: the one global
 * `keydown` layer, mounted once at the app root (`App.tsx`). Handles exactly FR-226's four direct
 * bindings:
 *  - Ctrl/Cmd+K: opens the Command Palette (FR-222). Not itself a registry command (see
 *    `commands.ts`'s own doc comment) — it's palette UI state, not an app action.
 *  - Ctrl/Cmd+Enter, Ctrl/Cmd+R (plus, Windows/Linux only, F5 as a second trigger for the same
 *    Refresh command — see `commands.ts`'s `keybindings` array): looked up BY keybinding from the
 *    one command registry (`getCommands`) — "Commit staged changes"/"Refresh commit graph" are
 *    each defined exactly once (FR-223) and reused verbatim here, `isAvailable` gating a silent
 *    no-op per FR-225.
 *  - Ctrl+Tab / Ctrl+Shift+Tab (Cmd on macOS): relative next/prev tab cycling, computed directly
 *    from `ctx.tabs`/`ctx.activeTabId` — not a registry command (there's no single fixed "the next
 *    tab": it depends on whichever tab is currently active).
 *
 * FR-221/FR-229: entirely inert — not even re-checking Ctrl/Cmd+K — whenever `dialogOpen` or the
 * palette itself (`paletteOpen`) is already true, since in both cases some OTHER surface (the
 * dialog's own local handler, or the palette's own filter-input handler) already owns this
 * keystroke.
 */
export function useGlobalKeybindings({ ctx, dialogOpen }: UseGlobalKeybindingsOptions): UseGlobalKeybindingsResult {
  const [paletteOpen, setPaletteOpen] = useState(false);

  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const dialogOpenRef = useRef(dialogOpen);
  dialogOpenRef.current = dialogOpen;
  const paletteOpenRef = useRef(paletteOpen);
  paletteOpenRef.current = paletteOpen;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (dialogOpenRef.current) return;
      if (paletteOpenRef.current) return;

      if (matchesKeyCombo(e, { key: "k", mod: true })) {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }

      const context = ctxRef.current;

      const isTabCycle =
        matchesKeyCombo(e, { key: "Tab", mod: true }) || matchesKeyCombo(e, { key: "Tab", mod: true, shift: true });
      if (isTabCycle) {
        // AC8: no effect at all (not even preventDefault) when there's nothing to cycle between.
        if (context.tabs.length <= 1) return;
        const idx = context.tabs.findIndex((t) => t.id === context.activeTabId);
        if (idx === -1) return;
        e.preventDefault();
        const delta = e.shiftKey ? -1 : 1;
        const nextIndex = (idx + delta + context.tabs.length) % context.tabs.length;
        context.activateTab(context.tabs[nextIndex]!.id);
        return;
      }

      for (const command of getCommands(context)) {
        if (!command.keybindings?.some((kb) => matchesKeyCombo(e, kb))) continue;
        // FR-225: an unavailable command's keybinding is a silent no-op, never a console error.
        if (command.isAvailable(context)) {
          e.preventDefault();
          command.run(context);
        }
        return;
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // Deliberately empty deps: the listener reads `ctx`/`dialogOpen`/`paletteOpen` through the
    // refs above on every keystroke, so it never needs to be torn down and re-attached.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    paletteOpen,
    openPalette: () => setPaletteOpen(true),
    closePalette: () => setPaletteOpen(false),
  };
}
