import type { ChangedFile } from "@githydra/git-core";
import { changedFileStatusColorVar, changedFileStatusLabel } from "../../lib/format";
import "./FileStatusIcon.css";

export interface FileStatusIconProps {
  status: ChangedFile["status"];
}

/** A single-letter, color-coded file-status glyph (DESIGN.md's status tokens) plus a visually
 * hidden text label for screen readers — colour is never the only signal. Shared by the commit
 * DetailPanel's file list and the Changes panel (FR-28: "consistent with the existing commit
 * DetailPanel's changed-file list"). */
export function FileStatusIcon({ status }: FileStatusIconProps) {
  return (
    <>
      <span className="gh-file-status-icon" style={{ color: changedFileStatusColorVar(status) }} aria-hidden="true">
        {status[0]!.toUpperCase()}
      </span>
      <span className="gh-visually-hidden">{changedFileStatusLabel(status)}:</span>
    </>
  );
}
