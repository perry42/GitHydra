// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from "react";
import type { WorktreeNotice, WorktreeNoticeAction } from "../../lib/worktreeNotices";
import { BannerIcon, type BannerTone } from "../StatusBanner/BannerIcon";
import "../StatusBanner/StatusBanner.css";

export interface WorktreeNoticesProps {
  notices: readonly WorktreeNotice[];
  onDismiss: (id: number) => void;
  /** FR-616: the kept-branch outcome offers "Open Branches". */
  onOpenBranches: () => void;
  /** Injectable for tests; defaults to the Clipboard API (never executes anything, FR-633). */
  writeClipboard?: (text: string) => Promise<void>;
}

/** The tone only picks the shared banner class; worktree banners add no styling of their own (specs/banner-uniform-look.md AC5). */
const TONE_CLASS: Record<BannerTone, string> = {
  info: "gh-status-banner--neutral",
  success: "gh-status-banner--neutral",
  warning: "gh-status-banner--warning",
  error: "gh-status-banner--critical",
};

function CopyButton({ action, write }: { action: Extract<WorktreeNoticeAction, { kind: "copy" }>; write: (t: string) => Promise<void> }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="gh-status-banner__action"
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

export function WorktreeNotices({ notices, onDismiss, onOpenBranches, writeClipboard = defaultWrite }: WorktreeNoticesProps) {
  if (notices.length === 0) return null;
  return (
    <div className="gh-status-banner-stack" aria-label="Worktree notices">
      {notices.map((n) => (
        <div key={n.id} className={`gh-status-banner ${TONE_CLASS[n.tone]}`} role={n.tone === "warning" || n.tone === "error" ? "alert" : "status"}>
          <BannerIcon tone={n.tone} />
          <span>
            {n.text}
            {n.detail && <span className="gh-status-banner__progress"> {n.detail}</span>}
          </span>
          <span className="gh-status-banner__op-actions">
            {n.actions.map((a) =>
              a.kind === "copy" ? (
                <CopyButton key={a.label} action={a} write={writeClipboard} />
              ) : a.kind === "openBranches" ? (
                <button key={a.label} type="button" className="gh-status-banner__action" onClick={onOpenBranches}>
                  {a.label}
                </button>
              ) : (
                // A disabled button is never a drop target here, but keep the reason reachable: aria-disabled, not `disabled`.
                <button
                  key={a.label}
                  type="button"
                  className="gh-status-banner__action"
                  aria-disabled="true"
                  title={a.reason}
                  onClick={(e) => e.preventDefault()}
                >
                  {a.label}
                </button>
              ),
            )}
            <button type="button" className="gh-status-banner__action" onClick={() => onDismiss(n.id)}>
              Dismiss
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
