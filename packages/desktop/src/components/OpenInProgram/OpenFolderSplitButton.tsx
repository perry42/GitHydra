// SPDX-License-Identifier: GPL-3.0-or-later
import { useId, useRef, useState } from "react";
import { buildOpenInProgramItem, resolveDefault, type OpenInProgramModel } from "../../lib/openInProgram";
import { ContextMenu } from "../ContextMenu/ContextMenu";
import { IconChevronDown, IconOpenInEditor } from "../Icon/Icon";
import "./OpenFolderSplitButton.css";

export interface OpenFolderSplitButtonProps {
  model: OpenInProgramModel;
  /** Why the folder cannot be opened now (no repository, or a bare one); null when it can. */
  disabledReason: string | null;
}

/**
 * specs/external-programs.md FR-624: "Open folder in editor" for the open repository, on any repo with or without worktrees. The main
 * part runs the default program (or opens the list on first run); the chevron opens the same accordion, expanded. There is no
 * "GitHydra tab" choice here: the repository is already open in a tab.
 */
export function OpenFolderSplitButton({ model, disabledReason }: OpenFolderSplitButtonProps) {
  const hintId = useId();
  const chevronRef = useRef<HTMLButtonElement | null>(null);
  const mainRef = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; returnTo: HTMLElement | null } | null>(null);
  const def = resolveDefault(model.snapshot, false);
  const hint = disabledReason ?? (def?.kind === "program" ? `Opens in ${def.name}` : "Choose a program");
  const disabled = disabledReason !== null;

  const openMenu = (from: HTMLElement | null) => {
    const r = from?.getBoundingClientRect();
    setMenu({ x: r ? r.left : 8, y: r ? r.bottom + 4 : 40, returnTo: from });
  };
  const chosen = useRef(false);
  const closeMenu = () => {
    const back = menu?.returnTo ?? null;
    const skip = chosen.current;
    chosen.current = false;
    setMenu(null);
    // Esc and an outside click return to the control that opened the list (FR-617).
    if (!skip && back && back.isConnected) queueMicrotask(() => back.focus());
  };
  const wrapped: OpenInProgramModel = {
    ...model,
    openInProgram: (id) => {
      chosen.current = true;
      model.openInProgram(id);
    },
    managePrograms: () => {
      chosen.current = true;
      model.managePrograms();
    },
  };

  return (
    <div className="gh-open-folder" role="group" aria-label="Open folder in editor">
      <button
        ref={mainRef}
        type="button"
        className="gh-open-folder__main"
        aria-disabled={disabled ? true : undefined}
        aria-describedby={hintId}
        title={`Open folder in editor. ${hint}`}
        onClick={() => {
          if (disabled) return;
          if (def?.kind === "program") model.openInProgram(def.id);
          else openMenu(chevronRef.current ?? mainRef.current);
        }}
      >
        <IconOpenInEditor size={14} />
        <span className="gh-open-folder__label">Open folder in editor</span>
      </button>
      <button
        ref={chevronRef}
        type="button"
        className="gh-open-folder__chevron"
        aria-label="Choose a program to open the folder in"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-disabled={disabled ? true : undefined}
        onClick={(e) => {
          if (disabled) return;
          if (menu) closeMenu();
          else openMenu(e.currentTarget);
        }}
      >
        <IconChevronDown size={12} />
      </button>
      <span id={hintId} className="gh-visually-hidden">
        {hint}
      </span>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          ariaLabel="Open folder in editor"
          items={[buildOpenInProgramItem(wrapped, { label: "Open folder in editor", includeTab: false, initiallyExpanded: true })]}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
