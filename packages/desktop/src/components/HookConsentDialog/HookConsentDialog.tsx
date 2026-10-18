// SPDX-License-Identifier: GPL-3.0-or-later
import { useId, useState } from "react";
import type { WorktreeHookChoice, WorktreeHookInfo } from "../../../shared/ipcContract";
import { visibleText } from "../../lib/worktrees";
import { ConfirmDialog } from "../ConfirmDialog/ConfirmDialog";
import "./HookConsentDialog.css";

export type PresentHookInfo = Extract<WorktreeHookInfo, { present: true }>;

export interface HookConsentDialogProps {
  info: PresentHookInfo;
  /** A refusal reason shown in the dialog (hookChanged re-opens it with fresh info). */
  notice?: string;
  busy?: boolean;
  onChoose: (choice: WorktreeHookChoice, remember: boolean) => void;
  /** Creates nothing. */
  onCancel: () => void;
}

export const HOOK_EXPLANATION =
  "This repository has a post-checkout hook: a program stored in the repository that git runs automatically after a checkout. It can run any code. Run it only if you trust this repository.";
export const HOOK_PRIVATE_COPY_NOTE =
  "The hook runs from a private copy. A hook that looks for files next to itself, or a temp folder that does not allow running programs, can fail.";
export const HOOK_BINARY_NOTE = "This file is not text.";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** Row breaks are the preview's own (git-core already wrapped it); visibleText would escape them, so it runs per row. */
const previewText = (preview: string): string => preview.split("\n").map(visibleText).join("\n");

/** "N more lines not shown" when the count is known; otherwise a plain statement (long wrapped lines, bytes beyond the window). */
export function notShownText(info: PresentHookInfo): string {
  const shownRows = info.preview === "" ? 0 : info.preview.split("\n").length;
  const more = info.previewLineCount - shownRows;
  if (more > 0) return `${more} more ${more === 1 ? "line" : "lines"} not shown`;
  return "More of this file is not shown";
}

/**
 * specs/worktrees.md FR-644: the hook-trust dialog on the ConfirmDialog shell. Cancel has the initial focus and "Run hook" is
 * never the default (it is the neutral button; "Skip hook" is the filled one). Every string from the repository is rendered as
 * a text node with invisible and right-to-left characters made visible.
 */
export function HookConsentDialog({ info, notice, busy = false, onChoose, onCancel }: HookConsentDialogProps) {
  const [remember, setRemember] = useState(false);
  const reasonId = useId();
  const relative = info.hooksPathRelative;
  const lineWord = info.previewLineCount === 1 ? "line" : "lines";

  return (
    <ConfirmDialog
      title="Run the post-checkout hook?"
      message={HOOK_EXPLANATION}
      confirmLabel="Skip hook"
      cancelLabel="Cancel"
      initialFocus="cancel"
      className="gh-hook-consent"
      busy={busy}
      confirmDisabled={busy}
      secondaryAction={{ label: "Run hook", disabled: busy || relative, onClick: () => onChoose("run", remember && !relative) }}
      notice={notice}
      onConfirm={() => onChoose("skip", remember && !relative)}
      onCancel={onCancel}
    >
      <div className="gh-hook-consent__body">
        <dl className="gh-hook-consent__facts">
          <div>
            <dt>Hook</dt>
            <dd className="gh-mono">{visibleText(info.hookPath)}</dd>
          </div>
          <div>
            <dt>core.hooksPath</dt>
            <dd className="gh-mono">{info.hooksPathConfig === null ? "not set" : visibleText(info.hooksPathConfig)}</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>
              {formatSize(info.size)}, {info.previewLineCount} {lineWord}
            </dd>
          </div>
        </dl>

        {info.previewIsBinary ? (
          <p className="gh-hook-consent__note gh-hook-consent__note--strong">{HOOK_BINARY_NOTE} What it does cannot be read here.</p>
        ) : (
          <>
            {/* tabIndex: a scrollable region must be reachable by keyboard. */}
            <pre className="gh-hook-consent__preview gh-mono" tabIndex={0} aria-label="Hook contents, read only">
              {previewText(info.preview)}
            </pre>
            {info.previewTruncated && <p className="gh-hook-consent__note">{notShownText(info)}</p>}
          </>
        )}

        {info.otherHooks.length > 0 && (
          <p className="gh-hook-consent__note">
            Other hooks in this folder: <span className="gh-mono">{info.otherHooks.map(visibleText).join(", ")}</span>. These stay disabled.
          </p>
        )}
        <p className="gh-hook-consent__note">{HOOK_PRIVATE_COPY_NOTE}</p>

        {relative ? (
          <p id={reasonId} className="gh-hook-consent__note gh-hook-consent__note--strong">
            Your core.hooksPath is a relative path, which would point inside the new worktree. GitHydra cannot run this hook, and the choice cannot be remembered. Skip the hook, or set an
            absolute core.hooksPath.
          </p>
        ) : (
          <label className="gh-hook-consent__remember">
            <input type="checkbox" checked={remember} disabled={busy} onChange={(e) => setRemember(e.target.checked)} />
            Remember my choice for this repository
          </label>
        )}
      </div>
    </ConfirmDialog>
  );
}
