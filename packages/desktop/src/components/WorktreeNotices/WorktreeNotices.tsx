// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from "react";
import type { WorktreeNotice, WorktreeNoticeLine } from "../../lib/worktreeNotices";
import { visibleText } from "../../lib/worktrees";
import { BannerIcon, type BannerTone } from "../StatusBanner/BannerIcon";
import "../StatusBanner/StatusBanner.css";
import "./WorktreeNotices.css";

export interface WorktreeNoticesProps {
  notices: readonly WorktreeNotice[];
  onDismiss: (id: number) => void;
  /** FR-616: the kept-branch outcome offers "Open Branches". */
  onOpenBranches: () => void;
  /** specs/external-programs.md FR-622: "Manage programs" on a failed launch. */
  onManagePrograms?: () => void;
  /** Injectable for tests; defaults to the Clipboard API (never executes anything, FR-633). */
  writeClipboard?: (text: string) => Promise<void>;
}

/** The tone only picks the shared banner class; worktree banners add no styling of their own (specs/banner-uniform-look.md AC5). */
const TONE_CLASS: Record<BannerTone, string> = {
  info: "gh-status-banner--neutral",
  success: "gh-status-banner--success",
  warning: "gh-status-banner--warning",
  error: "gh-status-banner--critical",
};

function CopyButton({ action, write }: { action: NonNullable<WorktreeNoticeLine["action"]>; write: (t: string) => Promise<void> }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="gh-status-banner__action gh-status-banner__action--quiet"
      onClick={() => {
        void write(action.text).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      {copied ? "Copied" : action.label}
    </button>
  );
}

function defaultWrite(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

export function WorktreeNotices({ notices, onDismiss, onOpenBranches, onManagePrograms, writeClipboard = defaultWrite }: WorktreeNoticesProps) {
  if (notices.length === 0) return null;
  return (
    <div className="gh-status-banner-stack gh-worktree-notices" role="region" aria-label="Worktree notices">
      {notices.map((n) => (
        // One live region per banner (the group is announced once); the lines inside carry no role of their own.
        <div key={n.id} className={`gh-status-banner ${TONE_CLASS[n.tone]}`} role={n.tone === "warning" || n.tone === "error" ? "alert" : "status"}>
          <BannerIcon tone={n.tone} />
          <div className="gh-worktree-notices__body">
            <span>
              {visibleText(n.text)}
              {n.detail && <span className="gh-worktree-notices__detail"> {visibleText(n.detail)}</span>}
            </span>
            {n.lines && n.lines.length > 0 && (
              <ul className="gh-worktree-notices__lines">
                {n.lines.map((l) => (
                  <li key={l.text}>
                    <span>{visibleText(l.text)}</span>
                    {l.action && <CopyButton action={l.action} write={writeClipboard} />}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <span className="gh-status-banner__op-actions">
            {n.actions.map((a) =>
              a.kind === "copy" ? (
                <CopyButton key={a.label} action={a} write={writeClipboard} />
              ) : (
                <button key={a.label} type="button" className="gh-status-banner__action" onClick={a.kind === "managePrograms" ? onManagePrograms : onOpenBranches}>
                  {a.label}
                </button>
              ),
            )}
            <button type="button" className="gh-status-banner__action gh-status-banner__action--quiet" onClick={() => onDismiss(n.id)}>
              Dismiss
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
