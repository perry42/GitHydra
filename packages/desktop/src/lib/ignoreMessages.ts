// SPDX-License-Identifier: GPL-3.0-or-later
import type { IgnoreReport, IgnoreRowReport, IgnoreScope, IgnoreTarget } from "@githydra/git-core";
import type { FileRow } from "./fileSelection";
import { plural } from "./fileSelection";

/**
 * specs/ignore-and-multiselect.md FR-494/FR-497/FR-502 (D1, D9): the scope menu's options and the honest one-line notice
 * after an ignore. Pure so every outcome's wording is unit-tested.
 */

export interface ScopeOption {
  scope: IgnoreScope;
  label: string;
  /** FR-501: a disabled option says why instead of vanishing. */
  disabledReason: string | null;
}

function baseName(path: string): string {
  const bare = path.replace(/\/$/, "");
  return bare.slice(bare.lastIndexOf("/") + 1);
}

/** The last extension only, with its dot (`a.tar.gz` gives `.gz`); null for no extension or a dotfile (FR-494). */
export function extensionOf(row: Pick<FileRow, "path" | "isDir">): string | null {
  if (row.isDir) return null;
  const base = baseName(row.path);
  const dot = base.lastIndexOf(".");
  return dot <= 0 || dot === base.length - 1 ? null : base.slice(dot);
}

/** The folder a Directory-scope rule would name: the parent, or the row itself for a directory row. Null at the repo root. */
export function directoryOf(row: Pick<FileRow, "path" | "isDir">): string | null {
  const bare = row.path.replace(/\/$/, "");
  if (row.isDir) return bare;
  return bare.includes("/") ? bare.slice(0, bare.lastIndexOf("/")) : null;
}

/** D1: This file / All *.ext files / All files in <dir>/, worded for one row or for a selection. */
export function scopeOptions(rows: readonly FileRow[]): ScopeOption[] {
  const exts = Array.from(new Set(rows.map(extensionOf).filter((e): e is string => e !== null)));
  const dirs = Array.from(new Set(rows.map(directoryOf).filter((d): d is string => d !== null)));
  const single = rows.length === 1;
  const row = rows[0];
  const nameLabel = single && row ? (row.isDir ? `This folder (${baseName(row.path)}/)` : "This file") : `These ${rows.length} files`;
  const extLabel =
    exts.length === 0
      ? "All files with this extension"
      : exts.length <= 3
        ? `All ${exts.map((e) => `*${e}`).join(", ")} files`
        : `All files with these ${exts.length} extensions`;
  const dirLabel =
    dirs.length === 0
      ? "All files in this folder"
      : dirs.length === 1
        ? `All files in ${dirs[0]}/`
        : `All files in these ${dirs.length} folders`;
  return [
    { scope: "name", label: nameLabel, disabledReason: null },
    {
      scope: "extension",
      label: extLabel,
      disabledReason: exts.length === 0 ? (single ? "This file has no extension." : "None of the selected files has an extension.") : null,
    },
    {
      scope: "directory",
      label: dirLabel,
      disabledReason: dirs.length === 0 ? (single ? "This file is in the repository root." : "All selected files are in the repository root.") : null,
    },
  ];
}

/** "Add to" choices: short select labels; `file` names the destination in the live summary line. */
export const IGNORE_TARGETS: { target: IgnoreTarget; label: string; file: string }[] = [
  { target: "root", label: ".gitignore", file: ".gitignore" },
  { target: "nearest", label: "Nearest .gitignore", file: "the nearest .gitignore" },
  { target: "exclude", label: "Private .git/info/exclude (this clone only)", file: ".git/info/exclude (private to this clone)" },
];

export interface ScopeImpact {
  /** Other changed files (not selected) that the scope's rule would also match. */
  others: number;
  /** Untracked files in the Changes list the rule would hide (selected + others); tracked files stay listed until untracked. */
  hidden: number;
}

/** What a scope's rule would touch among the files the Changes list shows. Pure, so the "+N files" counts are testable. */
export function scopeImpact(allRows: readonly FileRow[], selected: readonly FileRow[], scope: IgnoreScope): ScopeImpact {
  const selectedPaths = new Set(selected.map((r) => r.path));
  const exts = new Set(selected.map(extensionOf).filter((e): e is string => e !== null));
  const dirs = new Set(selected.map(directoryOf).filter((d): d is string => d !== null));
  const matches = (r: FileRow): boolean => {
    if (r.section === "conflicted") return false;
    if (scope === "name") return selectedPaths.has(r.path);
    if (scope === "extension") {
      const e = extensionOf(r);
      return e !== null && exts.has(e);
    }
    const bare = r.path.replace(/\/$/, "");
    for (const d of dirs) if (bare === d || bare.startsWith(`${d}/`)) return true;
    return false;
  };
  const seen = new Set<string>();
  let others = 0;
  let hidden = 0;
  for (const r of allRows) {
    if (seen.has(r.path) || !matches(r)) continue;
    seen.add(r.path);
    if (!selectedPaths.has(r.path)) others += 1;
    if (r.section === "untracked") hidden += 1;
  }
  return { others, hidden };
}

export function targetFileLabel(target: IgnoreTarget): string {
  return target === "exclude" ? ".git/info/exclude" : ".gitignore";
}

const ruleText = (rules: string[]): string => (rules.length === 1 ? rules[0]! : plural(rules.length, "rule"));

function groupBy(rows: IgnoreRowReport[], outcome: IgnoreRowReport["outcome"]): IgnoreRowReport[] {
  return rows.filter((r) => r.outcome === outcome);
}

export interface IgnoreNotice {
  text: string;
  /** "warn" when anything was refused, still-not-ignored or nothing happened; shown with words, never color alone. */
  tone: "ok" | "warn";
}

/** FR-497/FR-500/FR-502 (D9): one honest line for the result, naming the rule and the file. */
export function summarizeIgnoreReport(report: IgnoreReport): IgnoreNotice {
  const parts: string[] = [];
  let warn = false;
  const written = groupBy(report.rows, "written");
  if (written.length > 0) {
    const byFile = new Map<string, Set<string>>();
    for (const r of written) {
      const file = r.file ?? ".gitignore";
      byFile.set(file, (byFile.get(file) ?? new Set()).add(r.rule ?? ""));
    }
    parts.push(`Added ${Array.from(byFile, ([file, rules]) => `${ruleText([...rules])} to ${file}`).join(" and ")}`);
  }
  const already = groupBy(report.rows, "already-in");
  if (already.length > 0) {
    const files = Array.from(new Set(already.map((r) => r.file ?? ".gitignore")));
    const rules = Array.from(new Set(already.map((r) => r.rule ?? "")));
    parts.push(`${ruleText(rules)} ${rules.length === 1 ? "is" : "are"} already in ${files.join(" and ")}`);
    if (written.length === 0) warn = true;
  }
  const ignored = groupBy(report.rows, "already-ignored");
  if (ignored.length > 0) {
    const first = ignored[0]!;
    const by = first.ignoredBy ? `${first.ignoredBy.source}:${first.ignoredBy.line}` : "another rule";
    parts.push(
      ignored.length === 1
        ? `${first.path} is already ignored by ${by}; nothing was written`
        : `${plural(ignored.length, "file")} already ignored by other rules (first: ${by}); nothing was written for them`,
    );
    warn = true;
  }
  const still = groupBy(report.rows, "still-not-ignored");
  if (still.length > 0) {
    const first = still[0]!;
    const by = first.ignoredBy ? `. A later rule re-includes ${still.length === 1 ? "it" : "them"}: ${first.ignoredBy.pattern} (${first.ignoredBy.source}:${first.ignoredBy.line})` : "";
    parts.push(`${still.length === 1 ? first.path : plural(still.length, "file")} still not ignored${by}`);
    warn = true;
  }
  const refused = groupBy(report.rows, "refused");
  if (refused.length > 0) {
    const first = refused[0]!;
    parts.push(
      refused.length === 1
        ? `${first.path} was not ignored: ${first.reason ?? "refused"}`
        : `${plural(refused.length, "file")} not ignored (${first.reason ?? "refused"})`,
    );
    warn = true;
  }
  if (report.stopTracking && report.stopTracking.count > 0) {
    parts.push(`Stopped tracking ${plural(report.stopTracking.count, "file")}; they stay on disk and show as staged deletions`);
  }
  if (parts.length === 0) return { text: "Nothing was changed.", tone: "warn" };
  const text = parts.map((p) => p.replace(/\.$/, "")).join(". ") + ".";
  return { text, tone: warn ? "warn" : "ok" };
}
