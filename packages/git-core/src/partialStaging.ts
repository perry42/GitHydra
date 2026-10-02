// SPDX-License-Identifier: GPL-3.0-or-later
import { rmdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGit, runGitBuffer, SAFE_DIFF_FLAGS, runGitWithInput, runInMutationQueue, withFsmonitorNeutralized } from "./gitProcess";
import { DEFAULT_CONTEXT_LINES, DEFAULT_MAX_CHANGED_LINES, DEFAULT_MAX_FILE_SIZE_BYTES, getNewSideSizeBytes, parseNumstat, rawWorkdirDiffArgs } from "./diff";
import { buildPartialPatch, classifyRawDiff, fingerprintDiffBytes, parseRawDiff, type HunkSelection, type PatchDirection } from "./diffPatch";
import { InvalidArgumentError, PartialStagingIneligibleError, StaleDiffError } from "./errors";
import { assertPathWithinWorkdir } from "./pathSafety";

/**
 * specs/hunk-line-staging.md FR-448..452/456: stage, unstage or discard whole hunks or single changed
 * lines. The diff is re-read inside one mutation-queue entry, verified against the caller's
 * fingerprint (FR-449), turned into a patch from git's raw bytes (FR-450) and applied with
 * `git apply` (FR-451), so no other GitHydra write can interleave between check and apply.
 */

export interface PartialStagingOptions {
  /** Must equal the `contextLines` the displayed diff was read with. Default 3. */
  contextLines?: number;
}

export type Action = "stage" | "unstage" | "discard";

let afterCheckHook: (() => Promise<void>) | null = null;

/** Test-only: runs after the fingerprint check and before `git apply` (specs/hunk-line-staging.md AC5). */
export function _setPartialStagingAfterCheckHookForTests(hook: (() => Promise<void>) | null): void {
  afterCheckHook = hook;
}

const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });

/** Same flags as `rawWorkdirDiffArgs` (renames off) so the pre-check counts the lines the real diff will contain. */
function numstatArgs(side: "unstaged" | "staged", filePath: string): string[] {
  return withFsmonitorNeutralized([
    "diff", "--no-color", ...SAFE_DIFF_FLAGS, "--no-renames", ...(side === "staged" ? ["--cached"] : []), "--numstat", "--", filePath,
  ]);
}

function isValidUtf8(bytes: Buffer): boolean {
  try {
    UTF8_STRICT.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

let emptyHooksDir: Promise<string> | null = null;

/** A private empty dir to point core.hooksPath at: `/dev/null` resolves against the drive root on Windows. */
function getEmptyHooksDir(): Promise<string> {
  emptyHooksDir ??= fs.mkdtemp(path.join(os.tmpdir(), "githydra-nohooks-")).then(
    (dir) => {
      process.once("exit", () => {
        try {
          rmdirSync(dir);
        } catch {
          // best-effort cleanup only
        }
      });
      return dir.split("\\").join("/");
    },
    (err) => {
      emptyHooksDir = null;
      throw err;
    },
  );
  return emptyHooksDir;
}

async function applySelection(
  workdir: string,
  action: Action,
  filePath: string,
  fingerprint: string,
  selection: readonly HunkSelection[],
  options: PartialStagingOptions,
): Promise<void> {
  assertPathWithinWorkdir(workdir, filePath);
  if (typeof fingerprint !== "string" || fingerprint.length === 0) {
    throw new InvalidArgumentError("A diff fingerprint is required.");
  }
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
  if (!Number.isInteger(contextLines) || contextLines < 0) throw new InvalidArgumentError("contextLines must be a non-negative integer.");

  const side = action === "unstage" ? "staged" : "unstaged";
  const direction: PatchDirection = action === "stage" ? "forward" : "reverse";

  return runInMutationQueue(async () => {
    // Inner calls omit `mutatesRepository`: we already hold the queue (see `runInMutationQueue`).
    // Cheap bounded pre-checks first so an enormous diff is never buffered (mirrors getFileDiff's numstat/size guards).
    const { stdout: numstatOut } = await runGit(numstatArgs(side, filePath), { cwd: workdir });
    if (parseNumstat(numstatOut).changedLines > DEFAULT_MAX_CHANGED_LINES) throw new PartialStagingIneligibleError(filePath, "too-large");
    const preSize = await getNewSideSizeBytes(workdir, { kind: side, path: filePath });
    if (preSize !== null && preSize > DEFAULT_MAX_FILE_SIZE_BYTES) throw new PartialStagingIneligibleError(filePath, "too-large");

    const { stdout: rawBytes } = await runGitBuffer(rawWorkdirDiffArgs(side, filePath, contextLines), { cwd: workdir });

    if (rawBytes.length === 0) {
      if (side === "unstaged") {
        const { stdout } = await runGit(withFsmonitorNeutralized(["ls-files", "--stage", "--", filePath]), { cwd: workdir });
        if (stdout.trim() === "") throw new PartialStagingIneligibleError(filePath, "untracked");
      }
      if (fingerprint === fingerprintDiffBytes(rawBytes)) throw new PartialStagingIneligibleError(filePath, "no-changes");
      throw new StaleDiffError(filePath);
    }

    const rawText = rawBytes.toString("latin1");
    const reason = classifyRawDiff(rawText);
    if (reason && reason !== "empty") throw new PartialStagingIneligibleError(filePath, reason);
    if (!isValidUtf8(rawBytes)) throw new PartialStagingIneligibleError(filePath, "non-utf8");

    const raw = parseRawDiff(rawText);
    const changed = raw.hunks.reduce((n, h) => n + h.items.filter((i) => i.type !== "context").length, 0);
    if (changed > DEFAULT_MAX_CHANGED_LINES) throw new PartialStagingIneligibleError(filePath, "too-large");
    if (rawBytes.length > DEFAULT_MAX_FILE_SIZE_BYTES) {
      throw new PartialStagingIneligibleError(filePath, "too-large");
    }

    if (fingerprintDiffBytes(rawBytes) !== fingerprint) throw new StaleDiffError(filePath);

    const patch = buildPartialPatch(raw, selection, direction);
    await applyPatchBytes(workdir, action, direction, contextLines, patch);
  });
}

/**
 * Shared tail of every partial operation (also used by combinedStaging.ts, specs/hunk-line-staging.md FR-480).
 * Must run inside the mutation queue, after the caller's fingerprint check.
 */
export async function applyPatchBytes(
  workdir: string,
  action: Action,
  direction: PatchDirection,
  contextLines: number,
  patch: Buffer,
): Promise<void> {
  if (afterCheckHook) await afterCheckHook();

  // --whitespace=nowarn: a configured apply.whitespace=fix would rewrite the user's bytes. No --3way, no -C fuzz.
  const args = [
    "apply",
    ...(action === "discard" ? [] : ["--cached"]),
    ...(direction === "reverse" ? ["--reverse"] : []),
    "--whitespace=nowarn",
    ...(contextLines === 0 ? ["--unidiff-zero"] : []),
    "-",
  ];
  // Empty hooksPath: `apply --cached` otherwise fires a repo's post-index-change hook (FR-456).
  const hooksDir = await getEmptyHooksDir();
  await runGitWithInput(withFsmonitorNeutralized(["-c", `core.hooksPath=${hooksDir}`, ...args]), { cwd: workdir }, patch);
}

/** FR-448: stage selected hunks/lines from the unstaged diff (`git apply --cached`). */
export function stageSelection(
  workdir: string,
  filePath: string,
  fingerprint: string,
  selection: readonly HunkSelection[],
  options: PartialStagingOptions = {},
): Promise<void> {
  return applySelection(workdir, "stage", filePath, fingerprint, selection, options);
}

/** FR-448: unstage selected hunks/lines from the staged diff (`git apply --cached --reverse`). */
export function unstageSelection(
  workdir: string,
  filePath: string,
  fingerprint: string,
  selection: readonly HunkSelection[],
  options: PartialStagingOptions = {},
): Promise<void> {
  return applySelection(workdir, "unstage", filePath, fingerprint, selection, options);
}

/** FR-448: discard selected hunks/lines from the working tree only (`git apply --reverse`); destructive. */
export function discardSelection(
  workdir: string,
  filePath: string,
  fingerprint: string,
  selection: readonly HunkSelection[],
  options: PartialStagingOptions = {},
): Promise<void> {
  return applySelection(workdir, "discard", filePath, fingerprint, selection, options);
}
